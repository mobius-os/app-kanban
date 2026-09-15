# Offline coordinated migration

These administrative tools are not runtime endpoints and have no default data
paths. Run only with explicit owner authorization and backups.

1. Upgrade all retained participants and prove the old service request guard is
   active with all earlier unguarded workers drained. The legacy patch shows
   the boundary; adapt it to the actual old entrypoint and verify its source.
2. Freeze the exact board with `LegacyAuthority.freeze` under the shared request
   lease. The durable snapshot preserves original metadata and attachment bytes.
3. `stage` imports one inactive authority. Transfer each target grant using an
   authenticated owner channel; never print a production grant or put it in chat.
4. `install_member` installs only the named target and returns an exact receipt.
   Pending invitations stay pending. Preserve every intended deployment.
5. `activate` verifies unchanged frozen bytes and every install receipt before
   enabling the host. Receipts prove credential possession, not source readiness
   or independent owner consent: the trusted host can calculate them too.

For encrypted offline transfer, use `grant_transfer.seal` with a verified age
public recipient key. It writes a new ciphertext without overwriting files.
Recipients use `grant_transfer.install` with a protected 0600 local age identity
and the ciphertext checksum obtained independently from the authenticated
sender. Encryption alone does not authenticate who sent a grant. No plaintext
grant is written to disk by this helper. Both age and age-keygen must be
installed for its fixture tests; they are not app runtime dependencies.

Retries preserve grants and later membership decisions. Interrupted operations
resume from durable state. Do not unlink lock inodes, manually remove freeze
markers, or restore an old snapshot over an active board. No automatic reverse
migration is provided. Actual deployment drain, secure owner coordination and
real multi-host latency must be verified separately before cutover.
