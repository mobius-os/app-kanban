# Kanban

A clean, mobile-first kanban board for Möbius.

- Lists with counts, inline rename, safe delete confirmation, and a list menu
  to fold a list into a slim strip (remembered per person) or move it; on
  desktop a list can also be dragged by its header.
- Cards on the board show the full title, the first two lines of the
  description, the first picture or file, and a details row (label, due date,
  checklist, pull requests, attachment count, assignee).
- Drag and drop between lists (long-press on touch, drag on desktop), plus a
  status control at the top of the card sheet for accessibility.
- A card sheet with assignee, label and due-date chips, short previews of long
  notes, checklists and attachments, and an Activity history of who changed
  what and when. On a shared board an edit and its activity are saved together,
  and the host stamps who made it, when, and whether it was their agent; it
  keeps only entries that match what the edit changed, and writes titles, lists,
  labels, due dates and assignees from the card itself. A description save
  records only that the description changed, or a completion whose line it adds.
- A copy button on the card sheet puts the card's title and full description on
  the clipboard as Markdown, ready to paste into a chat.
- Deleting a card or a list deletes its files and activity; removing a file from
  a card deletes the file. Files are added and removed one at a time, by id,
  against the card as it is when the edit lands, so two people changing a
  card's files at once both keep their change; an older or stale copy of a
  card's file list can add files but never removes one, and a file another
  card still attaches is never deleted. A card holds at most 8 files.
- Known limits: a file removal queued offline by a Kanban older than 0.7.0 is
  a shortened file list, which 0.7 only adds from, so after updating that file
  stays on the card (remove it again). A file uploaded just before the app
  closed, or one a stale file list could not add to a full card, stays stored
  unattached and counts toward the board's file space until the board is deleted. Deleting a board deletes everything kept about it:
  its files and activity, edits still queued for it or kept for recovery,
  noticed assignment changes, capacity alerts and per-board view choices.
- Long notes and activity on shared boards are stored beside the board on its
  host, so the board document stays small; edits to the same notes are
  version-checked instead of silently overwritten.
- Local boards work offline and sync when you reconnect. Shared boards keep
  their last copy available offline and become editable again after reconnecting.
- Concurrent-edit safe: every change merges through compare-and-swap writes,
  and open boards repaint live when someone else edits, so two people editing
  the same board don't overwrite each other.
- Shared boards are stored in pieces on their host (each card, the lists, the
  board settings) with a numbered log of changes. An edit sends only the pieces
  it changed and a poll receives only the pieces changed since its copy, so
  both stay small however large the board grows; a new member downloads the
  board once. Two edits conflict only when they change the same card or the
  lists at the same moment.
- Shared-board limits, set by the host and shown to members: 2 MB for the board
  itself (descriptions over 400 characters and activity are kept beside it),
  16,000 characters per description, and 500 attachment files or 100 MB per
  board (5 MB per file, 8 per card). At 90% of a limit the board shows a warning
  and Kanban sends its owner one notification.
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

## Storage upgrade in 0.7

Kanban 0.7 stores the boards it hosts differently from 0.6, so updating a
hosting Kanban changes data that 0.6 cannot read:

- **What changes.** The first time the 0.7 service starts, every board it hosts
  is converted from one document into pieces (each card, the lists, the board
  settings). A description longer than 400 characters keeps a preview on the
  board (with `notesLength`); its full text moves into the card's record beside
  the board, next to the card's activity. The board's version, members,
  invitations and attachments are unchanged. All boards convert in one
  transaction: if anything fails, nothing changes and the next start tries again.
- **Backup.** Each board's 0.6 document is kept, unchanged, in a `board-backup`
  record in the same database, for **30 days**, then deleted automatically by
  the first request that arrives after that. Nothing reads it. It still holds anything deleted from the
  board since the upgrade (cards, descriptions, the names of removed files), and
  takes up to 256 KB per board (the 0.6 limit) outside the board's own limit.
  Deleting the board deletes it at once, and
  `python3 -m migration_tools.whole_boards <Kanban storage directory> --drop-backups`
  deletes every backup now, without changing any board.
- **Members.** Joined members on any version keep working: 0.6 members save
  whole boards, which the host stores as the pieces they changed, and their
  next poll receives the whole board once.
- **Going back to 0.6.** Stop the service, copy `collaboration.sqlite3`, then run
  `python3 -m migration_tools.whole_boards <Kanban storage directory>` from the
  app source and install 0.6. Each board becomes one document again, with full
  descriptions and every edit made since the upgrade. `--from-backup` instead
  restores the documents saved at the upgrade and discards later edits; use it
  only if a converted board itself is wrong, and within the 30 days: a board
  whose backup is gone (expired, or created after the upgrade) is rebuilt from
  its current state instead, and the tool prints a warning naming it. A
  restored board may still name files deleted since the upgrade; they show as
  unavailable. Activity
  has no place in 0.6 and stays in its records, unused, until the next upgrade.
- **Pre-release builds.** A Kanban built from this change before 0.7.0 saved
  activity through a separate request that 0.7 no longer has; until it updates,
  its edits save normally but record no activity.

The upgrade only touches boards this deployment hosts. Private boards, and the
copies kept of boards joined elsewhere, live in app storage and are not converted.

## Who an activity entry names

The board's host names the member it authenticated and uses its own clock;
neither can be set by the writer. "Agent" is how the request was made, not a
separate identity: on a deployment, a call made with the owner's token (the
agent helper, or the owner calling the service directly) or by a delegated
helper counts as the agent, while the Kanban app's own screen counts as the
person. A member's deployment states this for its own edits and the host
accepts it, so a member can label its own edits as its agent's (never as
anyone else's). Entry wording such as checklist text is the writer's, limited
to an edit that really changed that part of the card.

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
edits are saved locally before leaving the active queue. **Download recovery
copy** exports pending and rejected operations as JSON, including why each
rejected edit could not apply. Starting the download dismisses only the
exported rejected-edit reminders; saved copies remain on this instance, newly
arriving entries remain visible, and pending operations are not acknowledged.
The recovery copy is not automatically replayed onto another board or treated
as permission to write. If archival cannot be confirmed, the original intent
stays queued.
