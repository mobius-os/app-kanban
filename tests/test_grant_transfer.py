"""Real age execution, fixture keys and app data only; no inherited live state."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from collaboration.service import Service
from migration_tools.grant_transfer import seal, install
from migration_tools.legacy_authority import HandoffError


@unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'), 'age tools required')
class Transfer(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key, self.public = self.make_key('recipient.key')
        self.service = Service(self.root / 'app', host='peer.example', app_id=7)
        self.grant = dict(transition='a'*32, digest='b'*64, id='c'*32,
                          host='host.example', target='peer.example', member_id='d'*32,
                          credential='fixture-secret-do-not-log-0123456789', role='editor',
                          pending=False, label='Fixture')
        self.artifact = self.root / 'grant.age'

    def make_key(self, name):
        key = self.root / name
        subprocess.run(['age-keygen', '-o', str(key)], check=True, capture_output=True)
        public = subprocess.check_output(['age-keygen', '-y', str(key)], text=True).strip()
        return key, public

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def test_ciphertext_only_private_file_and_idempotent_install(self):
        checksum = seal(self.grant, self.public, self.artifact)
        self.assertNotIn(self.grant['credential'].encode(), self.artifact.read_bytes())
        self.assertEqual(self.artifact.stat().st_mode & 0o777, 0o600)
        receipt = install(self.service, self.artifact, self.key, checksum)
        self.assertNotIn('credential', receipt)
        self.assertEqual(install(self.service, self.artifact, self.key, checksum), receipt)
        self.assertEqual(len(self.service.store.list('joined')), 1)
        self.service.store.delete('joined', self.grant['host']+'/'+self.grant['id'])
        self.assertEqual(install(self.service, self.artifact, self.key, checksum), receipt)
        self.assertEqual(self.service.store.list('joined'), [])

    def test_wrong_key_and_tamper_do_not_install_or_echo_secrets(self):
        checksum = seal(self.grant, self.public, self.artifact)
        other, _ = self.make_key('other.key')
        for key, expected in [(other, checksum), (self.key, '0'*64)]:
            with self.assertRaises(HandoffError) as error:
                install(self.service, self.artifact, key, expected)
            self.assertNotIn(self.grant['credential'], str(error.exception))
        broken = self.artifact.read_bytes()[:-10] + b'corrupted!'
        self.artifact.write_bytes(broken)
        with self.assertRaises(HandoffError):
            install(self.service, self.artifact, self.key, hashlib.sha256(broken).hexdigest())
        self.assertEqual(self.service.store.list('joined'), [])

    def test_target_mismatch_rolls_back(self):
        checksum = seal({**self.grant, 'target': 'different.example'}, self.public, self.artifact)
        with self.assertRaises(HandoffError):
            install(self.service, self.artifact, self.key, checksum)
        self.assertEqual(self.service.store.list('joined'), [])

    def test_no_overwrite_or_symlink_replace_and_no_temporary_plaintext(self):
        seal(self.grant, self.public, self.artifact)
        original = self.artifact.read_bytes()
        with self.assertRaises(FileExistsError):
            seal(self.grant, self.public, self.artifact)
        self.assertEqual(self.artifact.read_bytes(), original)
        dangling = self.root / 'dangling.age'
        dangling.symlink_to(self.root / 'absent')
        with self.assertRaises(FileExistsError):
            seal(self.grant, self.public, dangling)
        self.assertTrue(dangling.is_symlink())
        self.assertEqual(list(self.root.glob('.grant-*')), [])

    def test_public_or_symlinked_identity_rejected(self):
        checksum = seal(self.grant, self.public, self.artifact)
        os.chmod(self.key, 0o644)
        with self.assertRaises(HandoffError):
            install(self.service, self.artifact, self.key, checksum)
        os.chmod(self.key, 0o600)
        link = self.root / 'linked.key'; link.symlink_to(self.key)
        with self.assertRaises(HandoffError):
            install(self.service, self.artifact, link, checksum)
        self.assertEqual(self.service.store.list('joined'), [])

    def test_malformed_grants_do_not_create_partial_membership(self):
        for i, change in enumerate([{'role':'owner'}, {'pending':'false'},
                                    {'credential':'short'}, {'id':'../wrong'}, {'label':None}]):
            artifact = self.root / f'bad-{i}.age'
            checksum = seal({**self.grant, **change}, self.public, artifact)
            with self.assertRaises(HandoffError):
                install(self.service, artifact, self.key, checksum)
        self.assertEqual(self.service.store.list('joined'), [])
        self.assertEqual(self.service.store.list('migration-member'), [])
