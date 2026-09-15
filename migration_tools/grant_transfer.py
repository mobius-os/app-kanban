"""Offline age-encrypted handoffs. No network, default paths, or plaintext files.

The sender verifies the recipient's public key through an authenticated owner
channel. The recipient obtains the exact ciphertext digest through that channel:
age encryption alone does not authenticate who sent a grant. Keys and grants
must never be returned to chat, command arguments, logs, or browser storage.
This module is administrative tooling, not an app endpoint.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

from .import_board import install_member
from .legacy_authority import HandoffError, canonical

LIMIT = 64 * 1024


def _age(args, data):
    try:
        result = subprocess.run(['age', *args], input=data, capture_output=True,
                                timeout=15, check=True)
    except (OSError, subprocess.SubprocessError):
        # Never attach subprocess stderr/output or grant material to an error.
        raise HandoffError('Encrypted grant operation failed; no membership changed.') from None
    if len(result.stdout) > LIMIT:
        raise HandoffError('Encrypted grant exceeds the handoff size limit.')
    return result.stdout


def seal(grant, recipient, destination):
    """Write a new ciphertext, returning only its public checksum.

    recipient is an age native public key, never a passphrase or secret key.
    Existing artifacts are not replaced: reuse a verified ciphertext for retry.
    """
    if not isinstance(recipient, str) or not re.fullmatch(r'age1[0-9a-z]{58}', recipient):
        raise HandoffError('An age recipient public key is required.')
    path = Path(destination)
    if not path.is_absolute() or not path.parent.is_dir():
        raise HandoffError('An explicit destination in an existing directory is required.')
    plaintext = canonical(grant)
    if len(plaintext) > LIMIT // 2:
        raise HandoffError('Grant exceeds the handoff size limit.')
    ciphertext = _age(['--encrypt', '--recipient', recipient], plaintext)
    fd, temporary = tempfile.mkstemp(prefix='.grant-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(ciphertext); out.flush(); os.fsync(out.fileno())
        # link is an atomic create-if-absent, including dangling symlinks.
        os.link(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return hashlib.sha256(ciphertext).hexdigest()


def install(service, artifact, identity, expected_sha256):
    """Decrypt directly into the target's transaction; return a nonsecret receipt.

    expected_sha256 must come from the authenticated sender, not from the
    untrusted artifact itself. Only explicit owner-side invocation may use this.
    A repeat uses install_member's durable receipt, never resurrects membership.
    """
    if not isinstance(expected_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', expected_sha256):
        raise HandoffError('A sender-verified ciphertext checksum is required.')
    key = Path(identity)
    info = key.lstat()
    if (not key.is_absolute() or not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600):
        raise HandoffError('Recipient identity must be an owned private regular file (0600).')
    with Path(artifact).open('rb') as source:
        ciphertext = source.read(LIMIT + 1)
    if len(ciphertext) > LIMIT or not hmac.compare_digest(hashlib.sha256(ciphertext).hexdigest(), expected_sha256):
        raise HandoffError('Ciphertext does not match the sender-verified handoff.')
    plaintext = _age(['--decrypt', '--identity', str(key)], ciphertext)
    try:
        grant = json.loads(plaintext)
        if not isinstance(grant, dict):
            raise ValueError()
        return install_member(service, grant)
    except (KeyError, TypeError, ValueError):
        raise HandoffError('Grant is invalid or conflicts with this deployment; nothing was replaced.') from None
