"""Card details beside the board: long descriptions and activity.

Hermetic, like test_collaboration.py: temporary Kanban roots and an in-memory
peer transport between two deployments.
"""
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlsplit
import httpx

from collaboration.service import (Service, PROTOCOL, MAX_ACTIVITY_PER_CARD, MAX_NOTES_CHARS,
    NOTES_PREVIEW_CHARS)

OWNER = {'scope': 'owner'}
LONG = 'Long description. ' * 60   # > NOTES_PREVIEW_CHARS


def board(notes='', cards=('c1',)):
    return {'v': 1, 'title': 'Fixture', 'columns': [{'id': 'todo', 'name': 'To do', 'cardIds': list(cards)}],
            'cards': {cid: {'id': cid, 'title': cid, 'notes': notes} for cid in cards}}


def entry(eid, at='2026-10-09T08:00:00.000Z', type='renamed', **extra):
    return {'id': eid, 'at': at, 'type': type, 'from': 'A', 'to': 'B', **extra}


class CardDetails(unittest.IsolatedAsyncioTestCase):
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

    async def call(self, service, method, path, body=None, status=200):
        result = await service.handle({'method': method, 'path': path, 'body': body, 'actor': OWNER, 'query': {}})
        self.assertEqual(result['status'], status, result)
        self.assertEqual(result['body']['protocol'], PROTOCOL)
        return result['body']

    async def join(self, role='editor'):
        invitation = await self.call(self.a, 'POST', f'boards/{self.oid}/invites', {'role': role})
        return await self.call(self.b, 'POST', 'boards/join', {'invite': invitation['invite']})

    async def write(self, service, doc, status=200):
        state = await self.call(service, 'GET', f'{self.base}/state')
        return await self.call(service, 'PUT', f'{self.base}/state', {'doc': doc, 'expected_version': state['version']}, status)

    async def test_long_description_moves_out_of_the_board_and_reads_back_whole(self):
        written = await self.write(self.a, board(LONG))
        card = (await self.call(self.a, 'GET', f'{self.base}/state'))['doc']['cards']['c1']
        self.assertEqual(card['notesLength'], len(LONG))
        self.assertLessEqual(len(card['notes']), NOTES_PREVIEW_CHARS)
        self.assertTrue(card['notes'].endswith('…'))
        # The writer gets the host's copy back, or it would keep full text the board no longer carries.
        self.assertEqual(written['doc']['cards']['c1'], card)
        details = await self.call(self.a, 'GET', f'{self.base}/cards/c1')
        self.assertEqual(details['notes'], LONG)
        self.assertIs(details['external'], True)

    async def test_short_description_stays_on_the_board(self):
        written = await self.write(self.a, board('Short note'))
        self.assertNotIn('doc', written)
        card = (await self.call(self.a, 'GET', f'{self.base}/state'))['doc']['cards']['c1']
        self.assertEqual(card['notes'], 'Short note')
        self.assertNotIn('notesLength', card)
        self.assertIs((await self.call(self.a, 'GET', f'{self.base}/cards/c1'))['external'], False)

    async def test_writer_resending_the_full_text_it_held_before_the_move_is_not_an_edit(self):
        await self.write(self.a, board(LONG))
        version = (await self.call(self.a, 'GET', f'{self.base}/state'))['version']
        before = await self.call(self.a, 'GET', f'{self.base}/cards/c1')
        stale = board(LONG)
        stale['title'] = 'Renamed'
        written = await self.call(self.a, 'PUT', f'{self.base}/state', {'doc': stale, 'expected_version': version})
        self.assertEqual(written['doc']['cards']['c1']['notesLength'], len(LONG))
        after = await self.call(self.a, 'GET', f'{self.base}/cards/c1')
        self.assertEqual((after['notes'], after['notes_version']), (LONG, before['notes_version']))

    async def test_older_kanban_cannot_truncate_a_moved_out_description(self):
        await self.write(self.a, board(LONG))
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        older = state['doc']
        older['cards']['c1']['notes'] = older['cards']['c1']['notes'] + ' edited preview'
        refused = await self.call(self.a, 'PUT', f'{self.base}/state', {'doc': older, 'expected_version': state['version']}, 403)
        # An older Kanban treats 'read-only' as final; any other code it retries forever.
        self.assertEqual(refused['code'], 'read-only')
        self.assertEqual((await self.call(self.a, 'GET', f'{self.base}/cards/c1'))['notes'], LONG)

    async def test_description_save_is_version_checked_and_updates_the_preview(self):
        await self.join()
        first = await self.call(self.b, 'PUT', f'{self.base}/cards/c1/notes', {'notes': LONG, 'expected_version': 0})
        self.assertEqual(first['status'], 'ok')
        self.assertEqual(first['card']['notesLength'], len(LONG))
        stale = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes', {'notes': 'Mine', 'expected_version': 0})
        self.assertEqual(stale['status'], 'conflict')
        self.assertEqual(stale['notes'], LONG)
        shorter = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes', {'notes': 'Mine', 'expected_version': stale['notes_version']})
        self.assertEqual(shorter['card']['notes'], 'Mine')
        self.assertNotIn('notesLength', shorter['card'])

    async def test_new_description_over_the_cap_is_refused(self):
        refused = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes',
                                  {'notes': 'x' * (MAX_NOTES_CHARS + 1), 'expected_version': 0}, 413)
        self.assertEqual(refused['code'], 'notes-too-long')

    async def test_older_description_over_the_cap_can_be_edited_but_not_grown(self):
        # Descriptions written before the cap move out whole on the first write.
        older = 'y' * (MAX_NOTES_CHARS + 500)
        await self.write(self.a, board(older))
        version = (await self.call(self.a, 'GET', f'{self.base}/cards/c1'))['notes_version']
        longer = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes',
                                 {'notes': older + ' more', 'expected_version': version}, 413)
        self.assertEqual(longer['code'], 'notes-too-long')
        shorter = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes',
                                  {'notes': older[:-100], 'expected_version': version})
        self.assertEqual(shorter['card']['notesLength'], len(older) - 100)

    async def test_activity_author_is_stamped_by_the_host_not_the_client(self):
        await self.join()
        saved = await self.call(self.b, 'POST', f'{self.base}/cards/c1/activity',
                                {'entries': [entry('e1', by={'host': 'forged.example', 'name': 'Someone else'})]})
        self.assertEqual(saved['activity'][0]['by'], {'host': 'b.example', 'name': 'B'})
        own = await self.call(self.a, 'POST', f'{self.base}/cards/c1/activity', {'entries': [entry('e2', at='2026-10-09T09:00:00Z')]})
        self.assertEqual(own['activity'][-1]['by'], {'host': 'a.example', 'name': 'A'})

    async def test_activity_replay_is_idempotent_and_capped(self):
        await self.call(self.a, 'POST', f'{self.base}/cards/c1/activity', {'entries': [entry('same')]})
        replay = await self.call(self.a, 'POST', f'{self.base}/cards/c1/activity', {'entries': [entry('same')]})
        self.assertEqual(len(replay['activity']), 1)
        for batch in range(4):
            entries = [entry(f'b{batch}x{i}', at=f'2026-10-09T10:{batch:02d}:{i:02d}Z') for i in range(40)]
            last = await self.call(self.a, 'POST', f'{self.base}/cards/c1/activity', {'entries': entries})
        self.assertEqual(len(last['activity']), MAX_ACTIVITY_PER_CARD)
        self.assertEqual(last['activity'][-1]['id'], 'b3x39')

    async def test_viewer_can_read_but_not_add_card_details(self):
        await self.join('viewer')
        await self.call(self.b, 'GET', f'{self.base}/cards/c1')
        denied = await self.call(self.b, 'POST', f'{self.base}/cards/c1/activity', {'entries': [entry('e1')]}, 403)
        self.assertEqual(denied['code'], 'read-only')
        await self.call(self.b, 'PUT', f'{self.base}/cards/c1/notes', {'notes': 'x', 'expected_version': 0}, 403)

    async def test_unknown_activity_type_is_refused(self):
        refused = await self.call(self.a, 'POST', f'{self.base}/cards/c1/activity', {'entries': [entry('e1', type='hacked')]}, 400)
        self.assertEqual(refused['code'], 'invalid-activity')

    async def test_deleting_a_card_removes_its_details(self):
        await self.write(self.a, board(LONG, cards=('c1', 'c2')))
        await self.call(self.a, 'POST', f'{self.base}/cards/c1/activity', {'entries': [entry('e1')]})
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        doc = state['doc']
        del doc['cards']['c1']; doc['columns'][0]['cardIds'] = ['c2']
        await self.call(self.a, 'PUT', f'{self.base}/state', {'doc': doc, 'expected_version': state['version']})
        self.assertIsNotNone(self.a.store.get('card', f'{self.oid}/c2'))
        self.assertIsNone(self.a.store.get('card', f'{self.oid}/c1'))
        self.assertEqual(await self.call(self.a, 'POST', f'{self.base}/cards/c1/activity', {'entries': [entry('e2')]}, 404),
                         {'protocol': PROTOCOL, 'code': 'card-missing', 'detail': 'Card not found.'})

    async def test_deleting_the_board_removes_card_details(self):
        await self.write(self.a, board(LONG))
        await self.call(self.a, 'DELETE', f'boards/{self.oid}')
        self.assertEqual(self.a.store.list('card'), [])


if __name__ == '__main__':
    unittest.main()
