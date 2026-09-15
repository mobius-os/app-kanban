# Backup-first host migration

These administrative tools are not runtime endpoints. Use explicit paths,
verified backups and owner authorization. Collaborators need not update together.

1. Back up the hosted board, attachments and local Kanban data; verify readback.
2. Activate the legacy request lease and drain every older unguarded worker.
3. Freeze the board: its durable archive includes document, version, attachments,
   former memberships and pending invitations before the old authority stops.
4. Stage the host import with its original local board ID. This preserves board
   content and attachments but grants access only to the host. No peer secrets
   are transferred and no collaborator receipts are required.
5. Activate only after the frozen source still matches exactly. Host retries do
   not overwrite later edits. Keep the archive; do not remove retirement markers.
6. Send ordinary fresh invitations after the approved rollout. Collaborators
   update when ready and rejoin; confirmed membership reuses matching old local
   aliases and preserves their pending-operation queue. An app update alone is
   not proof of membership and does not automatically grant access.

Backups on the host cannot contain unsent edits held only by a collaborator.
Keep their old app data and queues until rejoined; never delete and reinstall.
Actual cross-host propagation, presence, old-worker drain and frozen-backup
readback remain deployment checks, not claims made by the isolated tests.
