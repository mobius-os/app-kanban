---
name: kanban-agent
description: Find Kanban boards and cards; add, edit, or move to-dos using the app-owned helper. Also use when a completed task matches a Kanban card by its exact title, so the card can be marked done with a short summary and an optional link (a pull request, document, booking, receipt…).
---

# Working with Kanban

Use the installed app's helper instead of reconstructing its storage layout.
Locate the installed source directory with:
`python "$SCRIPTS_DIR/list_apps.py" --slug kanban --with-source-dir`.
Run `node <source_dir>/scripts/kanban.mjs` with the commands below. The helper
uses the current turn's credentials internally; never print them.

## Normal path

1. `list` returns boards with stable IDs, titles, and column IDs/names.
   A failed board remains in the list as `{id, status: "unavailable", error}`;
   healthy boards remain usable. Do not treat that entry as a missing/private
   board or invent its columns. Retry `read BOARD_ID` when its authority is
   reachable. Failure to list the board directory still fails the command.
2. `read BOARD_ID` returns the authoritative board, including its cards. On a
   shared board a long description stays beside the board: such a card has
   `notesLength` and only a preview in `notes`. `read-card BOARD_ID CARD_ID`
   returns that card with its full description, its `notesVersion`, and its
   activity (who changed what, when). To change such a description, start
   from the `read-card` text and send that `notesVersion` with `update-card`;
   an edit without it, or after someone else changed the text, is refused so
   a preview never replaces the full description. Edits made through this
   helper are recorded as the agent's.
3. Choose the intended board/column from those results, not guessed filenames.
   If several boards genuinely match, ask rather than silently picking the first.
4. Send one operation as JSON on stdin. Generate arbitrary text with a JSON
   encoder or a quoted input file rather than interpolating it into shell code.
5. A `status: saved` receipt means the authority confirmed the write. Keep its
   card ID; use `read` to inspect the result or reconcile an uncertain response.

Commands and stdin shapes:

- `add-card BOARD_ID`: `{"columnId":"...","title":"...","notes":"...","id":"optional-stable-id"}`
- `update-card BOARD_ID`: `{"cardId":"...","patch":{"title":"...","notes":"..."},"notesVersion":3}`
  (`notesVersion` only when changing the notes of a card that has `notesLength`)
  Other editable fields: label, due, assignee, assigneeHost, and
  `pullRequestUrls` (the card's full list of linked GitHub pull request URLs;
  read the card first and send the whole list, since it replaces the old one).
  `label` is a colour: none, red, amber, green, blue, purple or pink. A board's
  `labelNames` (shown by `read`) says what each colour means there, such as
  red = Urgent; choose the colour by that meaning.
- `move-card BOARD_ID`: `{"cardId":"...","toColumnId":"...","beforeCardId":null}`

## Marking a finished task done

When you finish a task whose exact title matches one Kanban card, use
`complete-matching-card` before finishing your turn. Send this JSON on stdin:

`{"title":"exact task title","summary":"short completion summary","link":"https://…"}`

`link` is optional: use it for whatever shows the result, such as a pull
request, shared document, booking, or receipt. The command appends
`✅ Done — <summary>` and the link to that card's notes, then moves it to the
column named **Done** when that column exists. A GitHub pull request link is
also added to the card's linked pull requests, so its live status shows there.
On a shared board a description cannot grow past 16,000 characters; when the
completion line would not fit, the card still moves and its activity records
the completion instead. It refuses to guess when zero or
multiple card titles match, and it does not duplicate a completion already on
the card. An unavailable recorded board or a title changed before the fresh
write also blocks automatic completion. A missing card or ambiguous title is a
visible blocker, not permission to update a different card.

### If GitHub is connected

To link the owner's open pull requests to their cards, run `sync-open-prs`. It
considers **only cards assigned to the current owner**, skips a pull request
already linked to any card, and skips one without a unique title-based match.
Use `sync-open-prs --dry-run` to inspect the proposed matches without changing
cards. When you can see which card a skipped PR belongs to, link it explicitly
with `update-card` instead. Without a GitHub connection the command reports
that and changes nothing.

Cards show each linked PR's status using the owner's own GitHub connection.
Without one, or for a PR that connection can't see, the card says so in a
neutral note; the link itself always works.

## Retries and limits

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
