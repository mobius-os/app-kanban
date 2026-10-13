"""Turn boards stored in pieces (Kanban 0.7+) back into whole documents (0.6).

An offline, administrative downgrade; never imported by a running service.
Stop the Kanban service (or install the older version) before running it,
and back up `collaboration.sqlite3` first.

    python3 -m migration_tools.whole_boards <kanban storage dir> [--from-backup]
    python3 -m migration_tools.whole_boards <kanban storage dir> --drop-backups

By default every board is rebuilt from its current pieces, so edits made
after the upgrade are kept: each long description gets its full text back
from its card record and loses `notesLength`. `--from-backup` instead restores
the document each board had at the moment of the upgrade (the 'board-backup'
record), discarding later edits; use it only if the converted board itself is
wrong. A board without a backup (created after the upgrade, or past the
BACKUP_DAYS expiry) is rebuilt from its pieces instead, and the tool names it.
A restored board may name files deleted since the upgrade; they show as
unavailable.

Card records (full descriptions and activity) are left in place: 0.6 ignores
them, and upgrading again reuses them. The upgrade marker is removed, so the
next 0.7 start converts the documents again.

`--drop-backups` changes no board: it deletes the documents saved at the
upgrade now, instead of when they expire (BACKUP_DAYS after the upgrade).
They keep whatever was deleted from a board since, so drop them once the
upgraded boards look right.
"""
import argparse
import sys
from pathlib import Path

from collaboration.service import BOARD_PIECES, card_key
from collaboration.store import Store


def whole_document(store, row):
    """The board in `row` as one document, long descriptions restored in full."""
    oid = row['id']
    cards = {}
    for key, piece in store.scan('board-card', oid + '/'):
        card_id = key.split('/', 1)[1]
        card = dict(piece['card'])
        if isinstance(card.pop('notesLength', None), int):
            record = store.get('card', card_key(oid, card_id)) or {}
            if isinstance(record.get('notes'), str):
                card['notes'] = record['notes']
        cards[card_id] = card
    return {**row['meta'], 'columns': row['columns'], 'cards': cards}


def restore_whole_boards(root, *, from_backup=False, rebuilt=None):
    """Rewrite every board in the store at `root` as a 0.6 document. Returns the board ids.

    With `from_backup`, the ids of boards that had no backup to restore are
    added to `rebuilt` (they were rebuilt from their pieces).
    """
    store = Store(Path(root))
    restored = []
    try:
        with store.transaction():
            for row in store.list('board'):
                if 'doc' in row:
                    continue
                backup = store.get('board-backup', row['id']) if from_backup else None
                if from_backup and not backup and rebuilt is not None:
                    rebuilt.append(row['id'])
                doc = backup['doc'] if backup else whole_document(store, row)
                for key in (*BOARD_PIECES, 'meta', 'cards_bytes', 'card_count', 'log_floor'):
                    row.pop(key, None)
                row['doc'] = doc
                if backup:
                    row['version'] = max(row['version'], backup['version']) + 1
                store.put('board', row['id'], row)
                store.delete_prefix('board-card', row['id'] + '/')
                store.delete_prefix('board-change', row['id'] + '/')
                restored.append(row['id'])
            store.delete('schema', 'board-pieces')
    finally:
        store.close()
    return restored


def drop_backups(root):
    """Delete every upgrade backup in the store at `root`. Returns how many there were."""
    store = Store(Path(root))
    try:
        with store.transaction():
            dropped = store.delete_kind('board-backup')
            store.delete('schema', 'backup-expiry')
    finally:
        store.close()
    return dropped


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('root', help="the Kanban app's storage directory (holds collaboration.sqlite3)")
    choice = parser.add_mutually_exclusive_group()
    choice.add_argument('--from-backup', action='store_true', help='restore the documents saved at the upgrade')
    choice.add_argument('--drop-backups', action='store_true', help='delete the documents saved at the upgrade; change no board')
    args = parser.parse_args(argv)
    if not (Path(args.root) / 'collaboration.sqlite3').is_file():
        parser.error('No collaboration.sqlite3 in that directory.')
    if args.drop_backups:
        print(f'Deleted {drop_backups(args.root)} upgrade backup(s).')
        return 0
    rebuilt = []
    restored = restore_whole_boards(args.root, from_backup=args.from_backup, rebuilt=rebuilt)
    print(f'Restored {len(restored)} board(s) as whole documents.')
    if rebuilt:
        print(f'Warning: {len(rebuilt)} board(s) had no upgrade backup (created after the upgrade, or the backup '
              f'expired) and were rebuilt from their current state instead: {", ".join(rebuilt)}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
