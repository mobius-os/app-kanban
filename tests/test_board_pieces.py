"""Boards stored in pieces: saves and polls exchange only what changed.

Hermetic, like test_card_details.py: temporary Kanban roots and an in-memory
peer transport between two deployments.
"""
import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.parse import urlsplit
import httpx

from collaboration import service as kanban
from collaboration.service import Service, PROTOCOL, MAX_DOC

OWNER = {'scope': 'owner'}


def board(cards=('c1', 'c2')):
    return {'v': 1, 'title': 'Fixture', 'columns': [{'id': 'todo', 'name': 'To do', 'cardIds': list(cards)}],
            'cards': {cid: {'id': cid, 'title': cid, 'notes': ''} for cid in cards}}


class BoardPieces(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.services = {}

        async def transport(method, url, **kwargs):
            parts = urlsplit(url)
            service = self.services[parts.hostname]
            result = await service.handle({'method': method, 'path': parts.path.split('/kanban/', 1)[1],
                                           'body': kwargs.get('json'), 'actor': {'scope': 'public'}})
            return httpx.Response(result['status'], json=result['body'])
        for name in ('a.example', 'b.example'):
            self.services[name] = Service(Path(self.temp.name) / name, host=name, app_id=7, request=transport,
                                          owner_name=name.split('.')[0].title())
        self.a, self.b = self.services['a.example'], self.services['b.example']
        self.oid = (await self.call(self.a, 'POST', 'boards', {'doc': board()}))['id']
        self.base = f'boards/a.example/{self.oid}'

    async def asyncTearDown(self):
        for service in self.services.values(): service.close()
        self.temp.cleanup()

    async def call(self, service, method, path, body=None, status=200, query=None):
        result = await service.handle({'method': method, 'path': path, 'body': body, 'actor': OWNER, 'query': query or {}})
        self.assertEqual(result['status'], status, result)
        self.assertEqual(result['body']['protocol'], PROTOCOL)
        return result['body']

    async def join(self, role='editor'):
        invitation = await self.call(self.a, 'POST', f'boards/{self.oid}/invites', {'role': role})
        return await self.call(self.b, 'POST', 'boards/join', {'invite': invitation['invite']})

    async def poll(self, service, since):
        return await self.call(service, 'GET', f'{self.base}/state', query={'since_version': str(since), 'changes': '1'})

    async def save(self, service, pieces, expected, status=200):
        return await self.call(service, 'POST', f'{self.base}/changes', {'pieces': pieces, 'expected_version': expected}, status)

    def card(self, cid, title):
        return {'id': cid, 'title': title, 'notes': ''}

    async def test_stored_size_matches_the_whole_board_as_json(self):
        await self.save(self.a, {'cards': {'c3': {'id': 'c3', 'title': 'Ünïcode ✓', 'notes': 'x' * 300}},
                                 'columns': [{'id': 'todo', 'name': 'To do', 'cardIds': ['c1', 'c2', 'c3']}]}, 1)
        row = self.a.board(self.oid)
        doc = self.a.board_document(row)
        self.assertEqual(kanban.document_bytes(row['meta'], row['columns'], row['cards_bytes'], row['card_count']),
                         len(json.dumps(doc).encode()))

    async def test_a_poll_receives_only_the_pieces_changed_since_its_version(self):
        await self.join()
        saved = await self.save(self.b, {'cards': {'c2': self.card('c2', 'Renamed')}}, 1)
        self.assertEqual(saved['version'], 2)
        changes = await self.poll(self.a, 1)
        self.assertNotIn('doc', changes)
        self.assertEqual(changes['since'], 1)
        self.assertEqual(changes['changes'], {'cards': {'c2': self.card('c2', 'Renamed')}})
        self.assertNotIn('changes', await self.poll(self.a, 2))

    async def test_saves_to_different_cards_do_not_conflict(self):
        await self.join()
        await self.save(self.b, {'cards': {'c1': self.card('c1', 'From B')}}, 1)
        # A still holds version 1; its card is untouched since, so it lands and
        # the reply also brings A the change it had not seen.
        saved = await self.save(self.a, {'cards': {'c2': self.card('c2', 'From A')}}, 1)
        self.assertEqual(saved['status'], 'ok')
        self.assertEqual(saved['version'], 3)
        self.assertEqual(set(saved['changes']['cards']), {'c1', 'c2'})

    async def test_saves_to_the_same_card_conflict_and_carry_the_newer_text(self):
        await self.join()
        await self.save(self.b, {'cards': {'c1': self.card('c1', 'From B')}}, 1)
        refused = await self.save(self.a, {'cards': {'c1': self.card('c1', 'From A')}}, 1)
        self.assertEqual(refused['status'], 'conflict')
        self.assertEqual(refused['changes']['cards']['c1']['title'], 'From B')
        self.assertEqual(self.a.board_card(self.a.board(self.oid), 'c1')['title'], 'From B')

    async def test_list_changes_conflict_with_each_other(self):
        moved = [{'id': 'todo', 'name': 'To do', 'cardIds': ['c2', 'c1']}]
        await self.save(self.a, {'columns': moved}, 1)
        refused = await self.save(self.a, {'columns': [{'id': 'todo', 'name': 'Renamed', 'cardIds': ['c1', 'c2']}]}, 1)
        self.assertEqual(refused['status'], 'conflict')
        self.assertEqual(refused['changes']['columns'], moved)

    async def test_a_deleted_card_arrives_as_none_and_its_details_go_with_it(self):
        await self.call(self.a, 'POST', f'{self.base}/changes', {'pieces': {'cards': {'c2': self.card('c2', 'b')}}, 'expected_version': 1,
                        'activity': {'c2': [{'id': 'e1', 'type': 'renamed', 'from': 'a', 'to': 'b'}]}})
        self.assertIsNotNone(self.a.store.get('card', f'{self.oid}/c2'))
        await self.save(self.a, {'cards': {'c2': None}, 'columns': [{'id': 'todo', 'name': 'To do', 'cardIds': ['c1']}]}, 2)
        self.assertEqual((await self.poll(self.a, 2))['changes']['cards'], {'c2': None})
        self.assertIsNone(self.a.store.get('card', f'{self.oid}/c2'))

    async def test_an_older_kanban_whole_board_save_is_logged_as_its_changes(self):
        doc = board()
        doc['cards']['c1']['title'] = 'Old app edit'
        await self.call(self.a, 'PUT', f'{self.base}/state', {'doc': doc, 'expected_version': 1})
        self.assertEqual((await self.poll(self.a, 1))['changes'], {'cards': {'c1': doc['cards']['c1']}})
        stale = await self.call(self.a, 'PUT', f'{self.base}/state', {'doc': board(), 'expected_version': 1})
        self.assertEqual(stale['status'], 'conflict')
        self.assertEqual(stale['doc']['cards']['c1']['title'], 'Old app edit')

    async def test_a_poll_without_changes_or_older_than_the_log_gets_the_whole_board(self):
        # An older Kanban never asks for changes.
        self.assertIn('doc', await self.call(self.a, 'GET', f'{self.base}/state', query={'since_version': '0'}))
        with mock.patch.object(kanban, 'MAX_CHANGE_LOG', 2):
            for n in range(4):
                await self.save(self.a, {'cards': {'c1': self.card('c1', f'Edit {n}')}}, n + 1)
            row = self.a.board(self.oid)
            self.assertEqual(row['log_floor'], 3)
            self.assertEqual(len(self.a.store.scan('board-change', self.oid + '/')), 2)
            whole = await self.poll(self.a, 2)
            self.assertEqual(whole['doc']['cards']['c1']['title'], 'Edit 3')
            self.assertIn('changes', await self.poll(self.a, 3))
            refused = await self.save(self.a, {'cards': {'c2': self.card('c2', 'Late')}}, 2)
            self.assertEqual(refused['status'], 'conflict')
            self.assertIn('doc', refused)

    async def test_a_board_stored_as_one_document_converts_once_and_keeps_its_version(self):
        row = self.a.store.get('board', self.oid)
        for key in ('columns', 'meta', 'cards_bytes', 'card_count', 'log_floor'): row.pop(key)
        legacy = board(('c1', 'c2', 'c3'))
        legacy['cards']['c3']['notes'] = 'long ' * 200
        row.update(doc=legacy, version=41)
        self.a.store.put('board', self.oid, row)
        self.a.store.delete('schema', 'board-pieces')
        self.a.store_boards_in_pieces()
        row = self.a.board(self.oid)
        self.assertNotIn('doc', row)
        self.assertEqual(row['version'], 41)
        converted = self.a.board_document(row)
        self.assertEqual(converted['cards']['c3']['notesLength'], 1000)
        self.assertEqual((await self.call(self.a, 'GET', f'{self.base}/cards/c3'))['notes'], 'long ' * 200)
        # A member's copy from before the conversion is replaced whole.
        self.assertIn('doc', await self.poll(self.a, 40))

    async def test_the_board_limit_applies_to_piece_saves(self):
        huge = {'id': 'c1', 'title': 'x' * MAX_DOC, 'notes': ''}
        refused = await self.save(self.a, {'cards': {'c1': huge}}, 1, 413)
        self.assertEqual(refused['code'], 'board-too-large')
        self.assertEqual(self.a.board(self.oid)['version'], 1)

    async def test_viewers_cannot_save_pieces(self):
        await self.join('viewer')
        refused = await self.save(self.b, {'cards': {'c1': self.card('c1', 'No')}}, 1, 403)
        self.assertEqual(refused['code'], 'read-only')

    async def test_the_board_reports_its_limits_to_members(self):
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        self.assertEqual(state['object']['limits'], {'board_bytes': 2 * 1024 * 1024, 'files': 500,
                                                     'file_bytes': 100 * 1024 * 1024})

    async def test_attachment_count_limit_and_replacing_an_attachment(self):
        data = base64.b64encode(b'file').decode()
        with mock.patch.object(kanban, 'MAX_BOARD_FILES', 2):
            for aid in ('one', 'two'):
                await self.call(self.a, 'PUT', f'{self.base}/assets/{aid}', {'mime': 'text/plain', 'data': data})
            full = await self.call(self.a, 'PUT', f'{self.base}/assets/three', {'mime': 'text/plain', 'data': data}, 413)
            self.assertEqual(full['code'], 'assets-full')
            await self.call(self.a, 'PUT', f'{self.base}/assets/two', {'mime': 'text/plain', 'data': data})

    async def test_deleting_a_board_removes_its_pieces_log_and_files(self):
        await self.save(self.a, {'cards': {'c1': self.card('c1', 'Logged')}}, 1)
        await self.call(self.a, 'PUT', f'{self.base}/assets/one', {'mime': 'text/plain', 'data': base64.b64encode(b'x').decode()})
        await self.call(self.a, 'DELETE', f'boards/{self.oid}')
        for kind in ('board-card', 'board-change', 'asset', 'card'):
            self.assertEqual(self.a.store.scan(kind, self.oid + '/'), [], kind)


if __name__ == '__main__':
    unittest.main()
