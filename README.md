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

Each local board lives in its own app-storage document. Sharing metadata and
offline copies of joined boards stay in the same app-scoped storage boundary.

## Development

Run `npm test` for the storage, sharing, access, and migration contracts.

## License

MIT — see [LICENSE](LICENSE).
