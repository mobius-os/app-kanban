# Kanban

A clean, mobile-first kanban board for Möbius.

- Lists with counts, inline rename, and safe delete confirmation.
- Cards with titles, notes, and color labels.
- Drag and drop between lists (long-press on touch, drag on desktop), plus
  visible "Move to" controls in the card sheet for accessibility.
- Local boards work offline and sync when you reconnect. Shared boards keep
  their last copy available offline and become editable again after reconnecting.
- Concurrent-edit safe: every change merges through compare-and-swap writes,
  and open boards repaint live when someone else edits, so two people editing
  the same board don't overwrite each other.
- Invitations appear without a refresh, shared boards show who is active, and
  cards include a compact two-line preview of their notes.

Private board documents are authoritative in app storage. Once shared, the
hosting deployment's Kanban service is authoritative and the app-storage board is an offline copy.
Use `boardRepository.js` for authoritative access; `storage.js` is the low-level
private/cache transport, not a universal board API.

## Agent use

See [kanban-agent.md](kanban-agent.md) for board discovery and card operations.
Run `node scripts/kanban.mjs list` inside a Möbius agent turn. The helper and UI
share board routing and mutation logic; agents do not need to distinguish
private storage from shared-object storage themselves.

## Development

Run `npm test` and `python3 -m unittest discover -s tests -p 'test_*.py' -q`.
Python tests use explicit temporary app roots, never a live platform database.

## License

MIT — see [LICENSE](LICENSE).

## Invitations across deployments

With an account-aware Möbius server, a bare account handle invites every
currently registered deployment for that account. Full addresses still invite
one deployment. People and presence group deployments invited through the registry into one
collaborator, and **Remove from all** revokes the whole invited group. Identical
display handles alone never merge memberships.

This is a snapshot of the account's deployments at invitation time: invite the
handle again after a new deployment is added, using the existing role. Delivery
failures are reported per deployment. Sending another invitation creates a new
expiring grant; there is no automatic background delivery job. Invitations do not move the board's hosting
location or synchronize unrelated Social messages.

## Collaboration ownership

Kanban owns its service, board data, membership credentials, attachments and
presence. Social is neither a runtime dependency nor an identity authority.
Each shared board has one hosting deployment. Members communicate directly
with that host over HTTPS; this is not independently writable multi-master P2P.
The host transaction owns document versions and role checks. Peer credentials
remain server-side; browser copies never contain those credentials.

Service identity `kanban` is stable across display-name changes. Installation
requires a platform supporting app-owned services with explicit `service.id`
and app-scoped identity lookup permission. Invite delivery is an unverified
notification until explicitly redeemed against the named host. Public display
names and claimed addresses are not authorization proofs.

## Existing shared boards

This release does not silently migrate boards hosted by Social. Old pointers
stay visible and pending edits remain intact. The host takes a verified backup,
freezes the old authority and imports the board and attachments once. Collaborators
can update independently and rejoin using fresh invitations. Successful joins
reuse matching local board identities so queued edits are not orphaned.

The offline `migration_tools` are host-only: frozen backup, staged import and
activation after rechecking the exact frozen bytes. They do not copy collaborator
credentials or require every deployment to be reachable. Former members and
pending invitations remain in the immutable backup, not as active new grants.
Old clients cannot continue writing the retired authority. No Social proxy or
automatic membership takeover is added. Actual old-worker drain and real two-host
performance still need deployment verification; never restore a stale snapshot
over later edits.

### Recovering edits that cannot sync

If your role changed or a card was deleted while you were offline, rejected
edits are saved locally before leaving the active queue. **Save unsynced edits**
on the board downloads both pending and rejected operations as JSON, including
why each rejected edit could not apply. The download does not delete the saved
copies or grant permission to write. An editor can use that file to recover the
intended work deliberately; it is not automatically replayed onto another board.
If the recovery copy cannot be confirmed, the original intent stays queued.
