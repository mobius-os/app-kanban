"""Mention notifications between deployments.

Hermetic, like test_card_details.py: temporary Kanban roots and an in-memory
peer transport. `self.down` makes a deployment unreachable, as when its
Möbius is restarting, asleep or offline.
"""
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlsplit
import httpx

from collaboration import mentions
from collaboration.service import Service, PROTOCOL

OWNER = {'scope': 'owner'}
APP = {'scope': 'app', 'app_id': 7}
DOC = {'v': 1, 'title': 'Fixture', 'columns': [{'id': 'todo', 'name': 'To do', 'cardIds': ['c1']}],
       'cards': {'c1': {'id': 'c1', 'title': 'Book the venue', 'notes': ''}}}


class Mentions(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = [1_000_000.0]
        self.services, self.down, self.pushes = {}, set(), {}

        async def transport(method, url, **kwargs):
            parts = urlsplit(url)
            if parts.hostname in self.down:
                raise httpx.ConnectError('unreachable')
            result = await self.services[parts.hostname].handle({'method': method, 'path': parts.path.split('/kanban/', 1)[1],
                                                                 'body': kwargs.get('json'), 'actor': {'scope': 'public'}})
            return httpx.Response(result['status'], json=result['body'])
        for name in ('a.example', 'b.example', 'c.example'):
            self.pushes[name] = []

            async def notify(payload, name=name):
                self.pushes[name].append(payload)
            self.services[name] = Service(Path(self.temp.name) / name, host=name, app_id=7, request=transport,
                                          owner_name=name.split('.')[0].title(), now=lambda: self.clock[0], notify=notify)
        self.a, self.b, self.c = (self.services[n] for n in ('a.example', 'b.example', 'c.example'))
        self.oid = (await self.call(self.a, 'POST', 'boards', {'doc': DOC}))['id']
        self.base = f'boards/a.example/{self.oid}'
        invitation = await self.call(self.a, 'POST', f'boards/{self.oid}/invites', {'role': 'editor'})
        self.b_id = (await self.call(self.b, 'POST', 'boards/join', {'invite': invitation['invite']}))['membership']['member_id']

    async def asyncTearDown(self):
        for service in self.services.values(): service.close()
        self.temp.cleanup()

    async def call(self, service, method, path, body=None, status=200, actor=OWNER):
        result = await service.handle({'method': method, 'path': path, 'body': body, 'actor': actor, 'query': {}})
        self.assertEqual(result['status'], status, result)
        self.assertEqual(result['body']['protocol'], PROTOCOL)
        return result['body']

    async def comment(self, service, mentioned, comment_id='k1', text='@b can you sign the deposit?'):
        return await self.call(service, 'POST', f'{self.base}/cards/c1/comments',
                               {'id': comment_id, 'text': text, 'mentions': mentioned})

    def outbox(self):
        return self.a.store.list(mentions.OUTBOX)

    async def badges(self, service):
        return (await self.call(service, 'GET', f'{self.base}/state'))['my_mentions']

    async def test_a_mention_reaches_the_member_once_with_a_badge_until_read(self):
        saved = await self.comment(self.a, [self.b_id])
        self.assertEqual(saved['comment']['mentions'], [self.b_id])
        self.assertEqual(len(self.pushes['b.example']), 1)
        push = self.pushes['b.example'][0]
        self.assertEqual(push['title'], 'A mentioned you')
        self.assertEqual(push['body'], 'Book the venue: @b can you sign the deposit?')
        self.assertEqual(push['target'], f'/shell/?app=7&intent=mention:{self.oid}:c1')
        self.assertEqual(self.outbox(), [], 'the member acknowledged it')
        self.assertEqual(await self.badges(self.b), {'c1': 1})
        # A replayed save is the same comment: no second notification.
        await self.comment(self.a, [self.b_id])
        self.assertEqual(len(self.pushes['b.example']), 1)
        read = await self.call(self.b, 'POST', f'{self.base}/cards/c1/mentions/read', {}, actor=APP)
        self.assertEqual(read['my_mentions'], {})
        self.assertEqual(await self.badges(self.b), {})
        self.assertEqual(self.pushes['a.example'], [], 'the author is never notified')

    async def test_a_member_mentioning_the_host_owner_notifies_without_a_network_hop(self):
        await self.comment(self.b, ['a.example'], text='@a deposit form is attached')
        self.assertEqual([p['title'] for p in self.pushes['a.example']], ['B mentioned you'])
        self.assertEqual(await self.badges(self.a), {'c1': 1})
        self.assertEqual(self.pushes['b.example'], [])

    async def test_only_admitted_members_other_than_the_author_are_notified(self):
        saved = await self.comment(self.a, ['a.example', 'not-a-member', self.b_id, self.b_id, 7])
        self.assertEqual(saved['comment']['mentions'], [self.b_id])
        plain = await self.comment(self.a, None, comment_id='k2', text='No one named here')
        self.assertNotIn('mentions', plain['comment'])
        self.assertEqual(len(self.pushes['b.example']), 1)

    async def test_an_unreachable_member_is_retried_with_backoff_then_handed_over_on_sync(self):
        self.down.add('b.example')
        await self.comment(self.a, [self.b_id])
        [record] = self.outbox()
        self.assertEqual((record['attempts'], record['next_at']), (1, self.clock[0] + 300))
        self.clock[0] += 299
        self.assertEqual((await self.call(self.a, 'POST', 'boards/mentions/retry', {}, actor=APP))['results'], [])
        self.clock[0] += 1
        retried = await self.call(self.a, 'POST', 'boards/mentions/retry', {}, actor=APP)
        self.assertEqual(retried['results'], [{'host': 'b.example', 'id': self.oid, 'delivery': 'unreachable'}])
        self.assertEqual(self.outbox()[0]['next_at'], self.clock[0] + 600, 'backs off: 5, 10, 20, 40 minutes, then hourly')
        # The member comes back: its next sync of the board collects the mention.
        self.down.discard('b.example')
        self.assertEqual(await self.badges(self.b), {'c1': 1})
        self.assertEqual(len(self.pushes['b.example']), 1)
        self.assertEqual(self.outbox(), [])

    async def test_backoff_settles_hourly_and_gives_up_after_a_week(self):
        self.down.add('b.example')
        await self.comment(self.a, [self.b_id])
        delays = []
        for _ in range(6):
            record = self.outbox()[0]
            delays.append(record['next_at'] - self.clock[0])
            self.clock[0] = record['next_at']
            await self.call(self.a, 'POST', 'boards/mentions/retry', {}, actor=APP)
        self.assertEqual(delays, [300, 600, 1200, 2400, 3600, 3600])
        self.clock[0] += mentions.MENTION_TTL
        await self.call(self.a, 'POST', 'boards/mentions/retry', {}, actor=APP)
        self.assertEqual(self.outbox(), [])

    async def test_an_older_kanban_without_the_wake_route_keeps_its_mention_until_it_updates(self):
        real = self.b.handle

        async def older(request):
            if request.get('path') == 'mentions/wake':
                return {'status': 404, 'body': {'protocol': PROTOCOL, 'code': 'route-missing', 'detail': 'No such Kanban route.'}}
            return await real(request)
        self.b.handle = older
        await self.comment(self.a, [self.b_id])
        self.assertEqual(len(self.outbox()), 1)
        self.b.handle = real  # Kanban updated: the next sync hands it over.
        self.assertEqual(await self.badges(self.b), {'c1': 1})
        self.assertEqual(self.outbox(), [])

    async def test_a_forged_wake_only_makes_the_member_pull_from_the_real_host(self):
        woke = await self.call(self.b, 'POST', 'mentions/wake', {'protocol': PROTOCOL, 'host': 'a.example', 'id': self.oid},
                               actor={'scope': 'public'})
        self.assertEqual(woke['status'], 'delivered')
        self.assertEqual(self.pushes['b.example'], [], 'nothing was waiting, so nothing is shown')
        stranger = await self.call(self.c, 'POST', 'mentions/wake', {'protocol': PROTOCOL, 'host': 'a.example', 'id': self.oid},
                                   status=404, actor={'scope': 'public'})
        self.assertEqual(stranger['code'], 'not-joined')

    async def test_removing_a_member_or_leaving_forgets_their_mentions(self):
        self.down.add('b.example')
        await self.comment(self.a, [self.b_id])
        await self.call(self.a, 'DELETE', f'boards/{self.oid}/members/{self.b_id}')
        self.assertEqual(self.outbox(), [])

    def test_the_notification_opens_the_cards_comments_tab_with_a_safe_tag(self):
        entry = {'oid': 'f' * 32, 'card_id': 'card-1', 'author': 'Maya', 'card_title': 'Venue', 'snippet': 'hi'}
        push = mentions.notification(entry, 9)
        self.assertEqual(push['target'], f"/shell/?app=9&intent=mention:{'f' * 32}:card-1")
        self.assertRegex(push['tag'], r'^[A-Za-z0-9_.:-]{1,128}$')


if __name__ == '__main__':
    unittest.main()
