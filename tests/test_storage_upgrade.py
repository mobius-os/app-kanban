"""The 0.7 storage upgrade: boards saved whole by Kanban 0.6 become pieces.

The fixture is the record table a Kanban 0.6.4 host wrote (generated with that
release's collaboration service): a hosted board with a joined member, an
attachment and a description longer than the board keeps.
"""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from collaboration import service as kanban
from collaboration.service import Service, NOTES_PREVIEW_CHARS, PROTOCOL
from collaboration.store import Store
from migration_tools.whole_boards import drop_backups, restore_whole_boards

FIXTURE = json.loads((Path(__file__).parent / 'fixtures' / 'kanban-0.6.4-host.json').read_text())
HOST, OID = FIXTURE['host'], FIXTURE['board']
OWNER = {'scope': 'owner'}
APP = {'scope': 'app', 'app_id': 7}


def original_doc():
    return next(r['body']['doc'] for r in FIXTURE['records'] if r['kind'] == 'board')


class StorageUpgrade(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.write_records(FIXTURE['records'])
        self.services = []

    def tearDown(self):
        for service in self.services: service.close()
        self.temp.cleanup()

    def write_records(self, records):
        """A database file exactly as the older release left it on disk."""
        store = Store(self.root)
        with store.transaction():
            for record in records:
                store.put(record['kind'], record['id'], record['body'])
        store.close()

    def rows(self, kind):
        db = sqlite3.connect(self.root / 'collaboration.sqlite3')
        try:
            return {key: json.loads(body) for key, body in db.execute('SELECT id, body FROM records WHERE kind=?', (kind,))}
        finally:
            db.close()

    def start(self):
        service = Service(self.root, host=HOST, app_id=7, owner_name='A')
        self.services.append(service)
        return service

    async def call(self, service, method, path, body=None, status=200, actor=APP):
        result = await service.handle({'method': method, 'path': path, 'body': body, 'actor': actor, 'query': {}})
        self.assertEqual(result['status'], status, result)
        self.assertEqual(result['body']['protocol'], PROTOCOL)
        return result['body']

    async def test_a_kanban_0_6_database_converts_when_the_service_starts(self):
        before = self.rows('board')[OID]
        service = self.start()
        row = self.rows('board')[OID]
        self.assertNotIn('doc', row)
        self.assertEqual(set(self.rows('schema')), {'board-pieces', 'backup-expiry'})
        # Version, membership and attachments are untouched; members get the whole board once.
        self.assertEqual(row['version'], before['version'])
        self.assertEqual(row['members'], before['members'])
        self.assertEqual(set(self.rows('asset')), {f'{OID}/file1'})
        state = await self.call(service, 'GET', f'boards/{HOST}/{OID}/state')
        doc, original = state['doc'], original_doc()
        self.assertEqual(doc['columns'], original['columns'])
        self.assertEqual(doc['cards']['short'], original['cards']['short'])
        long_card = doc['cards']['long']
        self.assertEqual(long_card['notesLength'], len(original['cards']['long']['notes']))
        self.assertLessEqual(len(long_card['notes']), NOTES_PREVIEW_CHARS)
        details = await self.call(service, 'GET', f'boards/{HOST}/{OID}/cards/long')
        self.assertEqual(details['notes'], original['cards']['long']['notes'])
        # The document as it was is kept, untouched, for a downgrade.
        backup = self.rows('board-backup')[OID]
        self.assertEqual((backup['doc'], backup['version']), (original, before['version']))

    async def test_starting_again_does_not_convert_again(self):
        self.start().close()
        backup = self.rows('board-backup')
        with mock.patch.object(Service, 'write_board_pieces', side_effect=AssertionError('converted twice')):
            self.start()
        self.assertEqual(self.rows('board-backup'), backup)

    async def test_a_failed_upgrade_leaves_every_board_as_it_was(self):
        second = json.loads(json.dumps(next(r for r in FIXTURE['records'] if r['kind'] == 'board')))
        second['id'] = second['body']['id'] = 'f' * 32
        self.write_records([second])
        before = self.rows('board')
        real = Service.write_board_pieces
        calls = []

        def fail_on_second(service, row, doc):
            calls.append(row['id'])
            if len(calls) == 2: raise OSError('disk full')
            return real(service, row, doc)
        with mock.patch.object(Service, 'write_board_pieces', fail_on_second):
            with self.assertRaises(OSError):
                Service(self.root, host=HOST, app_id=7, owner_name='A')
        self.assertEqual(self.rows('board'), before)
        for kind in ('schema', 'board-backup', 'board-card', 'card'):
            self.assertEqual(self.rows(kind), {}, kind)
        # The next start converts both.
        self.start()
        self.assertTrue(all('doc' not in row for row in self.rows('board').values()))
        self.assertEqual(len(self.rows('board-backup')), 2)

    async def test_the_downgrade_tool_rebuilds_whole_boards_with_later_edits(self):
        service = self.start()
        details = await self.call(service, 'GET', f'boards/{HOST}/{OID}/cards/long')
        edited = details['notes'] + ' Edited after the upgrade.'
        await self.call(service, 'PUT', f'boards/{HOST}/{OID}/cards/long/notes', {'notes': edited, 'expected_version': details['notes_version']})
        version = self.rows('board')[OID]['version']
        service.close(); self.services.remove(service)

        self.assertEqual(restore_whole_boards(self.root), [OID])
        row = self.rows('board')[OID]
        self.assertEqual(row['version'], version)
        # The row has exactly the fields Kanban 0.6 wrote.
        self.assertEqual(set(row), set(next(r['body'] for r in FIXTURE['records'] if r['kind'] == 'board')))
        self.assertEqual(row['doc']['cards']['long']['notes'], edited)
        self.assertNotIn('notesLength', row['doc']['cards']['long'])
        self.assertEqual(self.rows('board-card'), {})
        self.assertNotIn('board-pieces', self.rows('schema'))
        # Upgrading again converts the restored document, keeping the edit.
        again = self.start()
        self.assertEqual((await self.call(again, 'GET', f'boards/{HOST}/{OID}/cards/long'))['notes'], edited)

    async def test_the_downgrade_tool_can_restore_the_document_from_before_the_upgrade(self):
        service = self.start()
        state = await self.call(service, 'GET', f'boards/{HOST}/{OID}/state')
        card = {**state['doc']['cards']['short'], 'title': 'Changed after the upgrade'}
        await self.call(service, 'POST', f'boards/{HOST}/{OID}/changes', {'pieces': {'cards': {'short': card}}, 'expected_version': state['version']})
        version = self.rows('board')[OID]['version']
        service.close(); self.services.remove(service)

        restore_whole_boards(self.root, from_backup=True)
        row = self.rows('board')[OID]
        self.assertEqual(row['doc'], original_doc())
        # Newer than any copy a member holds, so every member takes the restored board.
        self.assertGreater(row['version'], version)

    async def test_a_failed_read_leaves_the_store_ready_for_the_next_request(self):
        service = self.start()
        with self.assertRaises(RuntimeError):
            with service.store.snapshot():
                service.store.get('board', OID)
                raise RuntimeError('read failed')
        self.assertFalse(service.store.db.in_transaction)
        # A refused member read fails inside the read-only snapshot, then a save still works.
        member_id = next(key for key, member in self.rows('board')[OID]['members'].items() if key != HOST)
        refused = await service.handle({'method': 'POST', 'path': f'peer/{OID}', 'actor': {'scope': 'public'},
            'body': {'protocol': PROTOCOL, 'op': 'state', 'member_id': member_id, 'credential': 'x' * 43}})
        self.assertEqual(refused['body']['code'], 'membership-revoked')
        self.assertFalse(service.store.db.in_transaction)
        state = await self.call(service, 'GET', f'boards/{HOST}/{OID}/state')
        card = {**state['doc']['cards']['plain'], 'title': 'Saved after a failed read'}
        saved = await self.call(service, 'POST', f'boards/{HOST}/{OID}/changes', {'pieces': {'cards': {'plain': card}}, 'expected_version': state['version']})
        self.assertEqual(saved['status'], 'ok')

    async def test_the_backup_expires_after_its_retention(self):
        Service(self.root, host=HOST, app_id=7, owner_name='A', now=lambda: 1_800_000_000).close()
        self.assertEqual(set(self.rows('board-backup')), {OID})
        Service(self.root, host=HOST, app_id=7, owner_name='A', now=lambda: 1_800_000_000 + (kanban.BACKUP_DAYS - 1) * 86400).close()
        self.assertEqual(set(self.rows('board-backup')), {OID})
        Service(self.root, host=HOST, app_id=7, owner_name='A', now=lambda: 1_800_000_000 + kanban.BACKUP_DAYS * 86400).close()
        self.assertEqual(self.rows('board-backup'), {})
        self.assertNotIn('backup-expiry', self.rows('schema'))

    async def test_backups_can_be_dropped_at_once_without_touching_boards(self):
        self.start().close()
        boards = self.rows('board')
        self.assertEqual(drop_backups(self.root), 1)
        self.assertEqual(self.rows('board-backup'), {})
        self.assertEqual(self.rows('board'), boards)

    async def test_restoring_from_an_expired_backup_rebuilds_and_says_so(self):
        self.start().close()
        drop_backups(self.root)
        rebuilt = []
        restore_whole_boards(self.root, from_backup=True, rebuilt=rebuilt)
        self.assertEqual(rebuilt, [OID])
        self.assertIn('doc', self.rows('board')[OID])

    async def test_deleting_a_board_removes_its_backup(self):
        service = self.start()
        await self.call(service, 'DELETE', f'boards/{OID}', actor=OWNER)
        self.assertEqual(self.rows('board-backup'), {})


if __name__ == '__main__':
    unittest.main()
