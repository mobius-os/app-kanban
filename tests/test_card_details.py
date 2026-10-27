"""Card details beside the board: long descriptions and activity.

Hermetic, like test_collaboration.py: temporary Kanban roots and an in-memory
peer transport between two deployments.
"""
from pathlib import Path
import tempfile
import unittest
import unittest.mock
from urllib.parse import urlsplit
import httpx

from collaboration.service import (Service, PROTOCOL, MAX_ACTIVITY_PER_CARD, MAX_NOTES_CHARS,
    NOTES_PREVIEW_CHARS)

OWNER = {'scope': 'owner'}          # the owner's token: the agent helper
APP = {'scope': 'app', 'app_id': 7}  # the Kanban app's own frame
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

    async def call(self, service, method, path, body=None, status=200, actor=OWNER):
        result = await service.handle({'method': method, 'path': path, 'body': body, 'actor': actor, 'query': {}})
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

    def store_as_one_document(self, doc):
        """Save the board the way a host did before boards were stored in pieces, then convert it."""
        row = self.a.store.get('board', self.oid)
        for key in ('columns', 'meta', 'cards_bytes', 'card_count', 'log_floor'): row.pop(key)
        row['doc'] = doc
        self.a.store.put('board', self.oid, row)
        self.a.store.delete('schema', 'board-pieces')
        self.a.store_boards_in_pieces()

    async def test_older_description_over_the_cap_can_be_edited_but_not_grown(self):
        # Descriptions written before the cap move out whole when the board is converted to pieces.
        older = 'y' * (MAX_NOTES_CHARS + 500)
        self.store_as_one_document(board(older))
        version = (await self.call(self.a, 'GET', f'{self.base}/cards/c1'))['notes_version']
        longer = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes',
                                 {'notes': older + ' more', 'expected_version': version}, 413)
        self.assertEqual(longer['code'], 'notes-too-long')
        shorter = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes',
                                  {'notes': older[:-100], 'expected_version': version})
        self.assertEqual(shorter['card']['notesLength'], len(older) - 100)

    async def test_a_board_save_cannot_grow_a_description_past_the_cap(self):
        # An older Kanban saves descriptions through the board, not the card route.
        refused = await self.write(self.a, board('z' * (MAX_NOTES_CHARS + 1)), 413)
        self.assertEqual(refused['code'], 'notes-too-long')
        self.assertEqual((await self.call(self.a, 'GET', f'{self.base}/cards/c1'))['notes'], '')

    async def save_card(self, service, title, entries, status=200, actor=APP, card_id='c1'):
        """Rename a card through a piece save that describes itself with `entries`."""
        state = await self.call(service, 'GET', f'{self.base}/state', actor=actor)
        card = {**state['doc']['cards'][card_id], 'title': title}
        return await self.call(service, 'POST', f'{self.base}/changes', {'pieces': {'cards': {card_id: card}},
            'expected_version': state['version'], 'activity': {card_id: entries}}, status, actor=actor)

    async def test_activity_commits_with_the_save_it_describes(self):
        saved = await self.save_card(self.a, 'Renamed', [entry('e1')])
        self.assertEqual([item['id'] for item in saved['activity']['c1']], ['e1'])
        details = await self.call(self.a, 'GET', f'{self.base}/cards/c1')
        self.assertEqual([item['id'] for item in details['activity']], ['e1'])
        self.assertEqual((await self.call(self.a, 'GET', f'{self.base}/state'))['doc']['cards']['c1']['title'], 'Renamed')

    async def test_a_conflicting_save_records_no_activity(self):
        await self.join()
        stale = await self.call(self.b, 'GET', f'{self.base}/state', actor=APP)
        await self.save_card(self.a, 'First', [entry('first')])
        card = {**stale['doc']['cards']['c1'], 'title': 'Second'}
        conflict = await self.call(self.b, 'POST', f'{self.base}/changes', {'pieces': {'cards': {'c1': card}},
            'expected_version': stale['version'], 'activity': {'c1': [entry('second')]}}, actor=APP)
        self.assertEqual(conflict['status'], 'conflict')
        self.assertEqual([item['id'] for item in (await self.call(self.a, 'GET', f'{self.base}/cards/c1'))['activity']], ['first'])

    async def test_invalid_activity_refuses_the_whole_save(self):
        refused = await self.save_card(self.a, 'Renamed', [{'id': '../bad', 'type': 'renamed'}], 400)
        self.assertEqual(refused['code'], 'invalid-request')
        self.assertEqual((await self.call(self.a, 'GET', f'{self.base}/state'))['doc']['cards']['c1']['title'], 'c1')

    async def test_activity_can_only_describe_a_card_the_save_changes(self):
        await self.write(self.a, board(cards=('c1', 'c2')))
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        refused = await self.call(self.a, 'POST', f'{self.base}/changes', {'pieces': {'cards': {'c1': {**state['doc']['cards']['c1'], 'title': 'x'}}},
            'expected_version': state['version'], 'activity': {'c2': [entry('e1')]}}, 400)
        self.assertEqual(refused['code'], 'invalid-activity')
        # The standalone activity route is gone: history only arrives with an edit.
        gone = await self.call(self.a, 'POST', f'{self.base}/cards/c1/activity', {'entries': [entry('e2')]}, 404)
        self.assertEqual(gone['code'], 'route-missing')

    async def test_activity_author_and_time_are_stamped_by_the_host_not_the_client(self):
        await self.join()
        forged = entry('e1', at='2099-01-01T00:00:00Z', by={'host': 'forged.example', 'name': 'Someone else'}, via='agent')
        saved = await self.save_card(self.b, 'By B', [forged])
        stamped = saved['activity']['c1'][0]
        self.assertEqual(stamped['by'], {'host': 'b.example', 'name': 'B'})
        self.assertNotEqual(stamped['at'], '2099-01-01T00:00:00Z')
        self.assertNotIn('via', stamped)  # the app's own frame is a person, whatever an entry claims

    async def test_agent_marker_comes_from_the_authenticated_caller(self):
        await self.join()
        own = await self.save_card(self.a, 'By the agent', [entry('e1')], actor=OWNER)
        self.assertEqual(own['activity']['c1'][-1]['via'], 'agent')
        # A member's agent: its deployment states it for the request it forwards.
        member = await self.save_card(self.b, "By B's agent", [entry('e2')], actor=OWNER)
        self.assertEqual(member['activity']['c1'][-1], {**member['activity']['c1'][-1], 'by': {'host': 'b.example', 'name': 'B'}, 'via': 'agent'})
        person = await self.save_card(self.b, 'By B', [entry('e3', via='agent')], actor=APP)
        self.assertNotIn('via', person['activity']['c1'][-1])

    async def test_future_dated_entries_cannot_push_out_history(self):
        await self.save_card(self.a, 'Early', [entry('early')])
        await self.save_card(self.a, 'Late', [entry(f'f{i}', at='2099-01-01T00:00:00Z') for i in range(40)])
        await self.save_card(self.a, 'Latest', [entry('latest')])
        ids = [item['id'] for item in (await self.call(self.a, 'GET', f'{self.base}/cards/c1'))['activity']]
        self.assertEqual((ids[0], ids[-1]), ('early', 'latest'))

    async def test_activity_replay_is_idempotent_and_capped(self):
        await self.save_card(self.a, 'Once', [entry('same')])
        replay = await self.save_card(self.a, 'Twice', [entry('same')])
        self.assertEqual(len(replay['activity']['c1']), 1)
        for batch in range(4):
            last = await self.save_card(self.a, f'Batch {batch}', [entry(f'b{batch}x{i}') for i in range(40)])
        self.assertEqual(len(last['activity']['c1']), MAX_ACTIVITY_PER_CARD)
        self.assertEqual(last['activity']['c1'][-1]['id'], 'b3x39')
        # Entries of one save keep the order they describe.
        self.assertEqual([item['id'] for item in last['activity']['c1'][-3:]], ['b3x37', 'b3x38', 'b3x39'])

    async def test_description_save_carries_its_activity(self):
        saved = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes',
                                {'notes': LONG, 'expected_version': 0, 'activity': [entry('n1', type='notes')]}, actor=APP)
        self.assertEqual([item['type'] for item in saved['activity']], ['notes'])
        unchanged = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes',
                                    {'notes': LONG, 'expected_version': saved['notes_version'], 'activity': [entry('n2', type='notes')]}, actor=APP)
        self.assertNotIn('activity', unchanged)
        self.assertEqual(len((await self.call(self.a, 'GET', f'{self.base}/cards/c1'))['activity']), 1)

    async def test_viewer_can_read_but_not_change_card_details(self):
        await self.join('viewer')
        await self.call(self.b, 'GET', f'{self.base}/cards/c1')
        denied = await self.save_card(self.b, 'No', [entry('e1')], 403)
        self.assertEqual(denied['code'], 'read-only')
        await self.call(self.b, 'PUT', f'{self.base}/cards/c1/notes', {'notes': 'x', 'expected_version': 0}, 403)

    async def test_activity_types_from_a_newer_kanban_are_skipped_not_refused(self):
        saved = await self.save_card(self.a, 'Renamed', [entry('e1', type='from-the-future'), entry('e2')])
        self.assertEqual([item['id'] for item in saved['activity']['c1']], ['e2'])

    async def test_reading_a_card_takes_no_write_lock(self):
        await self.call(self.a, 'GET', f'{self.base}/state')  # presence is fresh
        with unittest.mock.patch.object(self.a.store, 'transaction', side_effect=AssertionError('write lock taken')):
            await self.call(self.a, 'GET', f'{self.base}/cards/c1')

    async def test_deleting_a_card_removes_its_details(self):
        await self.write(self.a, board(LONG, cards=('c1', 'c2')))
        await self.save_card(self.a, 'Renamed', [entry('e1')])
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        doc = state['doc']
        del doc['cards']['c1']; doc['columns'][0]['cardIds'] = ['c2']
        await self.call(self.a, 'PUT', f'{self.base}/state', {'doc': doc, 'expected_version': state['version']})
        self.assertIsNotNone(self.a.store.get('card', f'{self.oid}/c2'))
        self.assertIsNone(self.a.store.get('card', f'{self.oid}/c1'))

    async def save_pieces(self, cards, entries, columns=None, actor=APP):
        state = await self.call(self.a, 'GET', f'{self.base}/state', actor=actor)
        pieces = {'cards': cards, **({'columns': columns} if columns is not None else {})}
        return await self.call(self.a, 'POST', f'{self.base}/changes', {'pieces': pieces,
            'expected_version': state['version'], 'activity': entries}, actor=actor)

    async def test_activity_must_match_what_the_edit_changed(self):
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        card = {**state['doc']['cards']['c1'], 'title': 'Real title'}
        claims = [entry('r1', type='renamed', **{'from': 'Fake', 'to': 'Also fake'}),
                  entry('d1', type='due', to='2030-01-01'), entry('m1', type='moved', to='Nowhere'),
                  entry('x1', type='checklist-added', text='Never added')]
        saved = await self.save_pieces({'c1': card}, {'c1': claims})
        # Only the rename happened; its titles come from the card, not the writer.
        self.assertEqual([(e['type'], e['from'], e['to']) for e in saved['activity']['c1']], [('renamed', 'c1', 'Real title')])

    async def test_an_unchanged_card_cannot_gain_activity(self):
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        saved = await self.save_pieces({'c1': state['doc']['cards']['c1']}, {'c1': [entry('e1')]})
        self.assertEqual(saved['activity']['c1'], [])

    async def test_moves_and_new_cards_name_the_lists_the_host_sees(self):
        await self.write(self.a, {**board(), 'columns': [{'id': 'todo', 'name': 'To do', 'cardIds': ['c1']},
                                                         {'id': 'done', 'name': 'Done', 'cardIds': []}]})
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        columns = [{'id': 'todo', 'name': 'To do', 'cardIds': ['c2']}, {'id': 'done', 'name': 'Done', 'cardIds': ['c1']}]
        saved = await self.save_pieces({'c1': {**state['doc']['cards']['c1'], 'title': 'c1'} | {'label': 'x'},
                                        'c2': {'id': 'c2', 'title': 'New', 'notes': ''}},
                                       {'c1': [entry('m1', type='moved', **{'from': 'A', 'to': 'B'})],
                                        'c2': [entry('n1', type='created', to='Somewhere else')]}, columns=columns)
        self.assertEqual([(e['from'], e['to']) for e in saved['activity']['c1']], [('To do', 'Done')])
        self.assertEqual(saved['activity']['c2'][0]['to'], 'To do')

    async def test_a_plain_move_keeps_its_history_when_the_card_travels_with_it(self):
        await self.write(self.a, {**board(), 'columns': [{'id': 'todo', 'name': 'To do', 'cardIds': ['c1']},
                                                         {'id': 'done', 'name': 'Done', 'cardIds': []}]})
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        columns = [{'id': 'todo', 'name': 'To do', 'cardIds': ['c2']}, {'id': 'done', 'name': 'Done', 'cardIds': ['c1']}]
        saved = await self.save_pieces({'c1': state['doc']['cards']['c1']},
                                       {'c1': [entry('m1', type='moved')]}, columns=columns)
        self.assertEqual([(e['type'], e['from'], e['to']) for e in saved['activity']['c1']], [('moved', 'To do', 'Done')])

    async def test_an_assignment_line_cannot_claim_an_earlier_event(self):
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        old_event = {'id': 'ev-old', 'at': '2026-10-01T00:00:00Z', 'from': {'label': '', 'host': ''}, 'to': {'label': 'Ana', 'host': ''}}
        await self.write(self.a, {**state['doc'], 'cards': {'c1': {**state['doc']['cards']['c1'], 'assignee': 'Ana', 'assignmentHistory': [old_event]}}})
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        card = {**state['doc']['cards']['c1'], 'assignee': 'Ben'}
        saved = await self.save_pieces({'c1': card}, {'c1': [entry('ev-old', type='assigned')]})
        line = saved['activity']['c1'][0]
        self.assertNotEqual(line['id'], 'ev-old')
        self.assertEqual((line['from'], line['to']), ('Ana', 'Ben'))

    async def test_a_description_save_can_only_be_described_as_one(self):
        saved = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes', {'notes': 'New', 'expected_version': 0,
            'activity': [entry('n1', type='notes'), entry('r1', type='renamed'),
                         entry('c1x', type='completed', text='Shipped', **{'from': 'X', 'to': 'Y'})]})
        # No completion line was added, so no completion is recorded.
        self.assertEqual([e['type'] for e in saved['activity']], ['notes'])

    async def test_a_completion_is_recorded_only_with_the_line_it_adds(self):
        saved = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes', {'notes': 'Work\n\n✅ Done — Shipped',
            'expected_version': 0, 'activity': [entry('c1', type='completed', text='Shipped', **{'from': 'X', 'to': 'Y'})]})
        self.assertEqual([(e['type'], e['text'], 'from' in e) for e in saved['activity']], [('completed', 'Shipped', False)])
        again = await self.call(self.a, 'PUT', f'{self.base}/cards/c1/notes', {'notes': 'Work\n\n✅ Done — Shipped\nmore',
            'expected_version': saved['notes_version'], 'activity': [entry('c2', type='completed', text='Shipped')]})
        self.assertEqual([e['id'] for e in again['activity']], ['c1'])

    async def test_two_members_changing_one_cards_files_at_once_cannot_delete_either(self):
        import base64
        await self.join()
        data = base64.b64encode(b'file').decode()
        for aid in ('A', 'B', 'C'):
            await self.call(self.a, 'PUT', f'{self.base}/assets/{aid}', {'mime': 'text/plain', 'data': data})
        files = lambda *ids: [{'id': i, 'name': i, 'mime': 'text/plain'} for i in ids]
        await self.save_pieces({'c1': {**(await self.call(self.a, 'GET', f'{self.base}/state'))['doc']['cards']['c1'], 'attachments': files('A')}}, {})
        both = await self.call(self.b, 'GET', f'{self.base}/state', actor=APP)
        save = lambda service, ids: self.call(service, 'POST', f'{self.base}/changes', {'pieces': {'cards': {'c1': {**both['doc']['cards']['c1'],
            'attachments': files(*ids)}}}, 'expected_version': both['version']}, actor=APP)
        self.assertEqual((await save(self.a, ('A', 'C')))['status'], 'ok')
        # The second writer saw the card before C was added: its save conflicts instead of dropping C.
        self.assertEqual((await save(self.b, ('A', 'B')))['status'], 'conflict')
        assets = sorted(key.split('/', 1)[1] for key, _ in self.a.store.scan('asset', self.oid + '/'))
        self.assertEqual(assets, ['A', 'B', 'C'])

    async def test_a_file_another_card_still_attaches_is_kept(self):
        import base64
        await self.write(self.a, board(cards=('c1', 'c2')))
        await self.call(self.a, 'PUT', f'{self.base}/assets/shared', {'mime': 'text/plain', 'data': base64.b64encode(b'x').decode()})
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        same = [{'id': 'shared', 'name': 'shared', 'mime': 'text/plain'}]
        await self.save_pieces({cid: {**state['doc']['cards'][cid], 'attachments': same} for cid in ('c1', 'c2')}, {})
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        await self.save_pieces({'c1': {**state['doc']['cards']['c1'], 'attachments': []}}, {})
        self.assertIsNotNone(self.a.store.get('asset', f'{self.oid}/shared'))

    async def test_a_file_goes_when_its_card_no_longer_attaches_it(self):
        import base64
        data = base64.b64encode(b'file').decode()
        await self.write(self.a, board(cards=('c1', 'c2')))
        for aid in ('one', 'two', 'three'):
            await self.call(self.a, 'PUT', f'{self.base}/assets/{aid}', {'mime': 'text/plain', 'data': data})
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        files = lambda *ids: [{'id': i, 'name': i, 'mime': 'text/plain'} for i in ids]
        await self.save_pieces({'c1': {**state['doc']['cards']['c1'], 'attachments': files('one', 'two')},
                                'c2': {**state['doc']['cards']['c2'], 'attachments': files('three')}}, {})
        assets = lambda: sorted(key.split('/', 1)[1] for key, _ in self.a.store.scan('asset', self.oid + '/'))
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        await self.save_pieces({'c1': {**state['doc']['cards']['c1'], 'attachments': files('two')}}, {})
        self.assertEqual(assets(), ['three', 'two'])
        # Deleting a card (here by an older Kanban's whole-board save) deletes its files.
        state = await self.call(self.a, 'GET', f'{self.base}/state')
        doc = state['doc']; del doc['cards']['c2']; doc['columns'][0]['cardIds'] = ['c1']
        await self.call(self.a, 'PUT', f'{self.base}/state', {'doc': doc, 'expected_version': state['version']})
        self.assertEqual(assets(), ['two'])

    async def test_deleting_the_board_removes_card_details(self):
        await self.write(self.a, board(LONG))
        await self.call(self.a, 'DELETE', f'boards/{self.oid}')
        self.assertEqual(self.a.store.list('card'), [])

    # ---- comments: stamped by the host, counted on the board card ----

    async def comment(self, service, cid='c1', text='Looks good', comment_id='k1', status=200, actor=OWNER):
        return await self.call(service, 'POST', f'{self.base}/cards/{cid}/comments',
                               {'id': comment_id, 'text': text}, status, actor=actor)

    async def test_a_comment_is_stamped_by_the_host_and_counted_on_the_board(self):
        await self.join()
        before = (await self.call(self.b, 'GET', f'{self.base}/state'))['version']
        saved = await self.comment(self.b, text='  Looks good  ')
        self.assertEqual(saved['comment']['text'], 'Looks good')
        self.assertEqual(saved['comment']['by'], {'host': 'b.example', 'name': 'B'})
        self.assertIn('at', saved['comment'])
        # The board card carries the count, so every member's poll sees the change.
        self.assertEqual(saved['card']['commentsCount'], 1)
        self.assertGreater(saved['version'], before)
        # The matching activity commits with the comment, in one transaction.
        self.assertEqual(saved['activity'][-1]['type'], 'commented')
        self.assertEqual(saved['activity'][-1]['text'], 'Looks good')
        self.assertEqual(saved['activity'][-1]['by']['host'], 'b.example')
        details = await self.call(self.a, 'GET', f'{self.base}/cards/c1')
        self.assertEqual([c['text'] for c in details['comments']], ['Looks good'])

    async def test_a_replayed_comment_saves_once(self):
        first = await self.comment(self.a)
        again = await self.comment(self.a)
        self.assertEqual(again['comment'], first['comment'])
        self.assertEqual(len(again['comments']), 1)
        self.assertEqual(again['card']['commentsCount'], 1)

    async def test_comment_refusals_leave_the_card_unchanged(self):
        body = await self.comment(self.a, text='   ', status=400)
        self.assertEqual(body['code'], 'invalid-comment')
        body = await self.comment(self.a, text='x' * 2001, status=413)
        self.assertEqual(body['code'], 'comment-too-long')
        body = await self.comment(self.a, cid='gone', status=404)
        self.assertEqual(body['code'], 'card-missing')
        await self.join(role='viewer')
        body = await self.comment(self.b, status=403)
        self.assertEqual(body['code'], 'read-only')
        card = (await self.call(self.a, 'GET', f'{self.base}/state'))['doc']['cards']['c1']
        self.assertNotIn('commentsCount', card)

    async def test_a_full_card_refuses_further_comments(self):
        with unittest.mock.patch('collaboration.service.MAX_COMMENTS_PER_CARD', 2):
            await self.comment(self.a, comment_id='k1')
            await self.comment(self.a, comment_id='k2')
            body = await self.comment(self.a, comment_id='k3', status=413)
        self.assertEqual(body['code'], 'comments-full')

    async def test_an_agent_comment_is_marked_as_the_agents(self):
        # The owner token reaches the service through the agent helper (agent_request).
        saved = await self.comment(self.a, actor=OWNER)
        self.assertEqual(saved['comment']['via'], 'agent')
        self.assertEqual(saved['activity'][-1]['via'], 'agent')
        # The app's own frame is not an agent.
        saved = await self.comment(self.a, comment_id='k2', actor=APP)
        self.assertNotIn('via', saved['comment'])


if __name__ == '__main__':
    unittest.main()
