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
federated object is authoritative and the app-storage board is an offline copy.
Use `boardRepository.js` for authoritative access; `storage.js` is the low-level
private/cache transport, not a universal board API.

## Agent use

See [kanban-agent.md](kanban-agent.md) for board discovery and card operations.
Run `node scripts/kanban.mjs list` inside a Möbius agent turn. The helper and UI
share board routing and mutation logic; agents do not need to distinguish
private storage from shared-object storage themselves.

## Development

Run `npm test` for the storage, sharing, access, and migration contracts.

## License

MIT — see [LICENSE](LICENSE).

## Invitations across deployments

With an account-aware Möbius server, a bare account handle invites every
currently registered deployment for that account. Full addresses still invite
one deployment. People and presence group these verified deployments into one
collaborator, and **Remove from all** revokes the whole invited group. Identical
display handles alone never merge memberships.

This is a snapshot of the account's deployments at invitation time: invite the
handle again after a new deployment is added, using the existing role. Delivery
failures are reported per deployment; **Send invite** retries pending delivery,
not an automatic background job. Invitations do not move the board's hosting
location or synchronize unrelated Social messages.
