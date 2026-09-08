---
name: kanban-agent
description: Find Kanban boards and cards; add, edit, or move to-dos using the app-owned helper. Use for any request to read or change Kanban data, whether private or shared.
---

# Working with Kanban

Use the installed app's helper instead of reconstructing its storage layout.
Locate the installed source directory with:
`python "$SCRIPTS_DIR/list_apps.py" --slug kanban --with-source-dir`.
Run `node <source_dir>/scripts/kanban.mjs` with the commands below. The helper
uses the current turn's credentials internally; never print them.

## Normal path

1. `list` returns boards with stable IDs, titles, and column IDs/names.
2. `read BOARD_ID` returns the authoritative board, including its cards.
3. Choose the intended board/column from those results, not guessed filenames.
   If several boards genuinely match, ask rather than silently picking the first.
4. Send one operation as JSON on stdin. Generate arbitrary text with a JSON
   encoder or a quoted input file rather than interpolating it into shell code.
5. A `status: saved` receipt means the authority confirmed the write. Keep its
   card ID; use `read` to inspect the result or reconcile an uncertain response.

Commands and stdin shapes:

- `add-card BOARD_ID`: `{"columnId":"...","title":"...","notes":"...","id":"optional-stable-id"}`
- `update-card BOARD_ID`: `{"cardId":"...","patch":{"title":"...","notes":"..."}}`
  Other editable fields: label, due, assignee, assigneeHost.
- `move-card BOARD_ID`: `{"cardId":"...","toColumnId":"...","beforeCardId":null}`

Use a stable new card ID when retrying an add. An uncertain network response
can mean the write landed; read before retrying, and reuse the same ID to avoid
duplicates. Don't use a title alone as an idempotency key.

The helper never queues agent changes invisibly: connection failures are
reported as not confirmed. Read-only boards are not editable. No sharing,
invitation, or deletion commands are provided; those need their own explicit
owner intent and existing app workflow.

## What owns the data

Private boards are authoritative in app storage. Shared boards are authoritative
in a federated shared object; the similarly shaped board file is only an offline
copy. `shared.json` maps the local board ID to that authority. The same
`boardRepository.js` routes UI and helper writes and authoritative helper reads,
including version-checked conflict handling.

Do not write directly to a shared board's offline copy and call the task done.
A successful file write/read-back proves only that the copy changed. The shared
board will replace it on sync. Raw storage remains useful for deliberate repair,
but it is not the normal card-editing interface.

The UI retains its offline operation queue and display cache. These are not a
second editable source of truth for an agent. Keep this guide and helper with
the app as its data model evolves.
