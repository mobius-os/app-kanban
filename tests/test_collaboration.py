"""Hermetic tests: explicit temporary Kanban roots and in-memory peer transport.
No platform imports, app installations, live credentials, or production writes.
"""
import asyncio
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import urlsplit
from unittest.mock import patch
import httpx

from collaboration.service import Service, PROTOCOL, Failure
from collaboration.store import Store

ROOT=Path(__file__).resolve().parents[1]
DOC={'v':1,'title':'Fixture','columns':[],'cards':{}}
OWNER={'scope':'owner'}

class Collaboration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.clock=[1000000.0]
        self.services={}
        self.calls=[]
        async def transport(method,url,**kwargs):
            parts=urlsplit(url); self.calls.append((method,parts.hostname,parts.path))
            service=self.services[parts.hostname]
            result=await service.handle({'method':method,'path':parts.path.split('/kanban/',1)[1], 'body':kwargs.get('json'),'actor':{'scope':'public'}})
            return httpx.Response(result['status'],json=result['body'])
        self.transport=transport
        for name in ('a.example','b.example','c.example'):
            self.services[name]=Service(Path(self.temp.name)/name,host=name,app_id=7,request=transport,now=lambda:self.clock[0])
        self.a=self.services['a.example']; self.b=self.services['b.example']
        self.oid=(await self.call(self.a,'POST','boards',{'doc':DOC}))['id']

    async def asyncTearDown(self):
        for s in self.services.values(): s.close()
        self.temp.cleanup()

    async def call(self,service,method,path,body=None,actor=OWNER,status=200,query=None):
        result=await service.handle({'method':method,'path':path,'body':body,'actor':actor,'query':query or {}})
        self.assertEqual(result['status'],status,result)
        self.assertEqual(result['body']['protocol'],PROTOCOL)
        return result['body']

    async def join(self,role='editor',service=None):
        invitation=await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'role':role})
        return await self.call(service or self.b,'POST','boards/join',{'invite':invitation['invite']})

    async def test_no_social_and_credentials_do_not_leak_to_browser(self):
        joined=await self.join()
        self.assertEqual(joined['membership']['transport'],PROTOCOL)
        self.assertNotIn('credential',json.dumps(joined))
        listing=await self.call(self.b,'GET','boards')
        self.assertEqual(listing['joined'][0]['id'],self.oid)
        self.assertNotIn('credential',json.dumps(listing))
        self.assertTrue(all('/kanban/' in c[2] for c in self.calls))
        for path in (ROOT/'collaboration').glob('*.py'):
            self.assertNotIn('import social',path.read_text())
            self.assertNotIn('from social',path.read_text())

    async def test_peer_cas_conflict_returns_the_whole_authority(self):
        await self.join()
        path=f'boards/a.example/{self.oid}/state'
        await self.call(self.b,'PUT',path,{'doc':{**DOC,'title':'Committed'},'expected_version':1})
        conflict=await self.call(self.b,'PUT',path,{'doc':DOC,'expected_version':1})
        self.assertEqual(conflict['status'],'conflict')
        self.assertEqual(conflict['doc']['title'],'Committed')
        self.assertEqual(conflict['version'],2)

    async def test_viewer_and_revocation_enforced_by_host(self):
        joined=await self.join('viewer')
        path=f'boards/a.example/{self.oid}/state'
        denial=await self.call(self.b,'PUT',path,{'doc':DOC,'expected_version':1},status=403)
        self.assertEqual(denial['code'],'read-only')
        await self.call(self.a,'DELETE',f"boards/{self.oid}/members/{joined['membership']['member_id']}")
        denial=await self.call(self.b,'GET',path,status=403)
        self.assertEqual(denial['code'],'membership-revoked')
        self.assertEqual(self.a.board(self.oid)['version'],1)

    async def test_another_board_or_claimed_host_cannot_authorize(self):
        joined=await self.join()
        m=self.b.store.get('joined','a.example/'+self.oid)
        other=(await self.call(self.a,'POST','boards',{'doc':DOC}))['id']
        result=await self.call(self.a,'POST','peer/'+other,{'protocol':PROTOCOL,'op':'write','member_id':m['member_id'],'credential':m['credential'],'host':'a.example','role':'editor','doc':DOC,'expected_version':1},actor={'scope':'public'},status=403)
        self.assertEqual(result['code'],'membership-revoked')

    async def test_platform_actor_scoping_and_delegation(self):
        for actor in ({'scope':'public'},{'scope':'app','app_id':9}):
            await self.call(self.a,'GET','boards',actor=actor,status=403)
        await self.call(self.a,'GET','boards',actor={'scope':'app','app_id':7})
        await self.call(self.a,'POST','boards',{'doc':DOC},actor={'scope':'owner','delegated':True},status=403)

    async def test_presence_cross_process_restart_and_expiry(self):
        await self.join()
        root=Path(self.temp.name)/'a.example'
        self.a.close()
        self.a=Service(root,host='a.example',app_id=7,request=self.transport,now=lambda:self.clock[0])
        self.services['a.example']=self.a
        state=await self.call(self.b,'GET',f'boards/a.example/{self.oid}/state')
        self.assertEqual(sum(m['active'] for m in state['object']['members'].values()),2)
        self.clock[0]+=13
        state=await self.call(self.a,'GET',f'boards/{self.oid}/members')
        self.assertFalse(any(m['active'] for m in state['members'].values()))
        self.assertEqual(state['version'],1)

    async def test_lost_join_response_retries_same_membership_after_restart(self):
        invitation=await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'role':'editor'})
        real=self.b.request
        async def lost(*args,**kwargs):
            await real(*args,**kwargs)
            raise OSError('Response lost after host commit')
        self.b.request=lost
        await self.call(self.b,'POST','boards/join',{'invite':invitation['invite']},status=502)
        before=self.b.store.get('joined','a.example/'+self.oid)
        self.b.close()
        self.b=Service(Path(self.temp.name)/'b.example',host='b.example',app_id=7,request=self.transport,now=lambda:self.clock[0])
        self.services['b.example']=self.b
        joined=await self.call(self.b,'POST','boards/join',{'invite':invitation['invite']})
        self.assertEqual(joined['membership']['member_id'],before['member_id'])
        self.assertEqual(len(self.a.board(self.oid)['members']),2)

    async def test_gateway_404_and_403_never_mean_deleted_or_revoked(self):
        await self.join()
        for status in (404,403):
            async def gateway(*args,**kwargs): return httpx.Response(status,json={'detail':'Route unavailable'})
            self.b.request=gateway
            result=await self.call(self.b,'PUT',f'boards/a.example/{self.oid}/state',{'doc':DOC,'expected_version':1},status=502)
            self.assertEqual(result['code'],'authority-unavailable')
            await self.call(self.b,'POST',f'boards/a.example/{self.oid}/leave',status=502)
            self.assertIsNotNone(self.b.store.get('joined','a.example/'+self.oid))

    async def test_attachment_membership_viewer_and_bounds(self):
        await self.join()
        path=f'boards/a.example/{self.oid}/assets/image'
        await self.call(self.b,'PUT',path,{'mime':'image/png','data':'aGVsbG8='})
        self.assertEqual((await self.call(self.b,'GET',path))['asset']['data'],'aGVsbG8=')
        viewer=self.services['c.example']; await self.join('viewer',viewer)
        await self.call(viewer,'DELETE',path,status=403)
        await self.call(self.b,'PUT',path,{'mime':'image/png','data':'not base64'},status=400)
        await self.call(self.b,'DELETE',path)
        await self.call(self.b,'GET',path,status=404)

    async def test_expiry_single_use_and_decline_not_undone_by_delivery(self):
        invite=await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'role':'viewer','ttl_seconds':1})
        body={'protocol':PROTOCOL,'invite':invite['invite'],'label':'Fixture','role':'viewer'}
        await self.call(self.b,'POST','invitations/deliver',body,actor={'scope':'public'})
        await self.call(self.b,'POST',f'boards/invitations/a.example/{self.oid}/decline')
        await self.call(self.b,'POST','invitations/deliver',body,actor={'scope':'public'})
        self.assertEqual((await self.call(self.b,'GET','boards/invitations'))['invitations'],[])
        self.clock[0]+=2
        await self.call(self.b,'POST','boards/join',{'invite':invite['invite']},status=403)

    async def test_handle_delivery_uses_registry_not_social(self):
        async def resolve(handle):
            self.assertEqual(handle,'person'); return ['b.example','c.example']
        self.a.resolve=resolve
        result=await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'role':'viewer','address':'person'})
        self.assertEqual(result['delivery'],'delivered')
        first=await self.call(self.b,'POST','boards/join',{'host':'a.example','id':self.oid})
        await self.call(self.services['c.example'],'POST','boards/join',{'host':'a.example','id':self.oid})
        mid=first['membership']['member_id']
        result=await self.call(self.a,'DELETE',f'boards/{self.oid}/members/{mid}',query={'all_deployments':['true']})
        self.assertEqual(len(result['hosts']),2)

    async def test_invitation_batch_capacity_failure_mints_nothing(self):
        async def resolve(handle): return ['b.example', 'c.example']
        self.a.resolve = resolve
        self.a.mint_grants(self.oid, 'viewer', [None] * 99)
        before = self.a.board(self.oid)['invites']
        await self.call(self.a, 'POST', f'boards/{self.oid}/invites', {'address':'fixture'}, status=429)
        self.assertEqual(self.a.board(self.oid)['invites'], before)
        self.assertEqual(self.calls, [])

    async def test_slow_invitation_target_does_not_block_other_deliveries(self):
        async def resolve(handle): return ['b.example', 'c.example']
        self.a.resolve = resolve
        second_started = asyncio.Event()
        async def deliver(method, url, **kwargs):
            if urlsplit(url).hostname == 'b.example':
                await asyncio.wait_for(second_started.wait(), .5)
            else:
                second_started.set()
            return await self.transport(method, url, **kwargs)
        self.a.request = deliver
        result = await self.call(self.a, 'POST', f'boards/{self.oid}/invites', {'address':'fixture'})
        self.assertEqual(result['delivery'], 'delivered')
        self.assertEqual(len(result['recipients']), 2)

    async def test_atomic_rollback_never_splits_doc_version_or_membership(self):
        before=self.a.board(self.oid)
        with self.assertRaises(RuntimeError):
            with self.a.store.transaction():
                self.a.store.put('board',self.oid,{**before,'version':99,'doc':{**DOC,'title':'Must rollback'}})
                raise RuntimeError('Interrupted transaction')
        self.assertEqual(self.a.board(self.oid),before)

    async def test_concurrent_processes_allow_one_cas_writer(self):
        root=Path(self.temp.name)/'a.example'
        def write(title):
            code="""import asyncio,json,sys\nfrom collaboration.service import Service\ns=Service(sys.argv[1],host='a.example',app_id=7)\nr=asyncio.run(s.handle({'method':'PUT','path':'boards/a.example/'+sys.argv[2]+'/state','actor':{'scope':'owner'},'body':{'doc':{'v':1,'title':sys.argv[3],'columns':[],'cards':{}},'expected_version':1}}))\ns.close()\nprint(json.dumps(r))"""
            env={'PATH':os.environ['PATH'],'PYTHONPATH':str(ROOT)}
            p=subprocess.run([sys.executable,'-c',code,str(root),self.oid,title],env=env,capture_output=True,text=True,timeout=20,check=True)
            return json.loads(p.stdout)['body']
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            a=pool.submit(write,'A'); b=pool.submit(write,'B'); results=[a.result(),b.result()]
        self.assertEqual(sorted(r['status'] for r in results),['conflict','ok'])
        self.assertEqual(self.a.board(self.oid)['version'],2)

    async def test_json_v1_subprocess_uses_only_explicit_fixture_storage(self):
        root=Path(self.temp.name)/'json-v1'
        env={'PATH':os.environ['PATH'],'APP_STORAGE_DIR':str(root),'INSTANCE_DOMAIN':'d.example','APP_ID':'77','API_BASE_URL':'http://127.0.0.1:1','APP_TOKEN':'fixture-not-live'}
        def run(request):
            p=subprocess.run([sys.executable,str(ROOT/'service.py')],env=env,input=json.dumps(request),capture_output=True,text=True,timeout=20,check=True)
            return json.loads(p.stdout)
        created=run({'method':'POST','path':'boards','actor':OWNER,'body':{'doc':DOC}})
        self.assertEqual(created['status'],200)
        listing=run({'method':'GET','path':'boards','actor':OWNER})
        self.assertEqual(listing['body']['hosted'][0]['id'],created['body']['id'])
        self.assertEqual(list(root.rglob('*.sqlite3')),[root/'server/collaboration.sqlite3'])

    async def test_publication_retry_cannot_overwrite_a_later_shared_edit(self):
        oid='d'*32
        body={'id':oid,'local_id':'private-board','doc':DOC}
        await self.call(self.a,'POST','boards',body)
        await self.call(self.a,'PUT',f'boards/a.example/{oid}/state',{'doc':{**DOC,'title':'Later shared edit'},'expected_version':1})
        retry=await self.call(self.a,'POST','boards',body)
        self.assertEqual(retry['version'],2)
        self.assertEqual(self.a.board(oid)['doc']['title'],'Later shared edit')
        await self.call(self.a,'POST','boards',{**body,'local_id':'another-private-board'},status=409)

    async def test_saved_join_is_recoverable_without_the_browser_invitation(self):
        invitation=await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'role':'viewer'})
        real=self.b.request
        async def lost(*args,**kwargs):
            await real(*args,**kwargs)
            raise OSError('lost reply')
        self.b.request=lost
        await self.call(self.b,'POST','boards/join',{'invite':invitation['invite']},status=502)
        self.b.request=real
        result=await self.call(self.b,'POST','boards/resume-joins')
        self.assertEqual(result['results'][0]['status'],'joined')
        listing=await self.call(self.b,'GET','boards')
        self.assertEqual(listing['joined'][0]['role'],'viewer')
        self.assertNotIn('credential',json.dumps(listing))

    async def test_expired_join_can_use_a_new_invitation_without_losing_retry_identity(self):
        old=await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'role':'viewer','ttl_seconds':1})
        self.clock[0]+=2
        await self.call(self.b,'POST','boards/join',{'invite':old['invite']},status=403)
        before=self.b.store.get('joined','a.example/'+self.oid)
        fresh=await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'role':'viewer'})
        joined=await self.call(self.b,'POST','boards/join',{'invite':fresh['invite']})
        self.assertEqual(joined['membership']['member_id'],before['member_id'])

    async def test_new_grant_after_revocation_does_not_reuse_revoked_credentials(self):
        joined=await self.join()
        old=self.b.store.get('joined','a.example/'+self.oid)
        await self.call(self.a,'DELETE',f"boards/{self.oid}/members/{old['member_id']}")
        await self.call(self.b,'GET',f'boards/a.example/{self.oid}/state',status=403)
        new=await self.join('viewer')
        fresh=self.b.store.get('joined','a.example/'+self.oid)
        self.assertNotEqual(old['member_id'],fresh['member_id'])
        self.assertNotEqual(old['credential'],fresh['credential'])
        self.assertEqual(new['membership']['role'],'viewer')
        await self.call(self.a,'POST','peer/'+self.oid,{'protocol':PROTOCOL,'op':'state','member_id':old['member_id'],'credential':old['credential']},actor={'scope':'public'},status=403)

    async def test_new_invite_after_decline_does_not_resurrect_old_delivery(self):
        first=await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'role':'viewer'})
        second=await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'role':'viewer'})
        async def deliver(inv): return await self.call(self.b,'POST','invitations/deliver',{'protocol':PROTOCOL,'invite':inv['invite']},actor={'scope':'public'})
        for invitation in (first,second):
            await deliver(invitation)
            self.assertEqual(len((await self.call(self.b,'GET','boards/invitations'))['invitations']),1)
            await self.call(self.b,'POST',f'boards/invitations/a.example/{self.oid}/decline')
        await deliver(first)
        self.assertEqual((await self.call(self.b,'GET','boards/invitations'))['invitations'],[])

    async def test_public_peer_cannot_smuggle_an_owner_action_or_a_role_upgrade(self):
        await self.join('viewer')
        m=self.b.store.get('joined','a.example/'+self.oid)
        response=await self.call(self.a,'POST','peer/'+self.oid,{'protocol':PROTOCOL,'op':'write','member_id':m['member_id'],'credential':m['credential'],'actor':OWNER,'role':'editor','expected_version':1,'doc':DOC},actor={'scope':'public'},status=403)
        self.assertEqual(response['code'],'read-only')
        await self.call(self.a,'POST','peer/'+self.oid,{'protocol':PROTOCOL,'op':'delete','member_id':m['member_id'],'credential':m['credential']},actor={'scope':'public'},status=400)
        self.assertEqual(self.a.board(self.oid)['version'],1)

    async def test_invalid_version_and_unbounded_invitations_fail_without_writes(self):
        for version in (True,0,-1,1.5,'1'):
            await self.call(self.a,'PUT',f'boards/a.example/{self.oid}/state',{'expected_version':version,'doc':DOC},status=400)
        await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'role':'editor','ttl_seconds':8*86400},status=400)
        self.assertEqual(self.a.board(self.oid)['version'],1)


    async def test_pending_join_recovery_is_fair_across_restart(self):
        other=self.services['c.example']
        oid=(await self.call(other,'POST','boards',{'doc':DOC}))['id']
        first=(await self.call(self.a,'POST',f'boards/{self.oid}/invites'))['invite']
        second=(await self.call(other,'POST',f'boards/{oid}/invites'))['invite']
        async def offline(*args,**kwargs): raise OSError('fixture offline')
        self.b.request=offline
        for invitation in (first,second):
            await self.call(self.b,'POST','boards/join',{'invite':invitation},status=502)
        result=await self.call(self.b,'POST','boards/resume-joins')
        self.assertEqual(result['results'][0]['host'],'a.example')
        self.assertEqual(result['results'][0]['status'],'unavailable')
        self.b.close()
        self.b=Service(Path(self.temp.name)/'b.example',host='b.example',app_id=7,
            request=self.transport,now=lambda:self.clock[0])
        self.services['b.example']=self.b
        async def first_still_offline(method,url,**kwargs):
            if urlsplit(url).hostname=='a.example': raise OSError('fixture offline')
            return await self.transport(method,url,**kwargs)
        self.b.request=first_still_offline
        result=await self.call(self.b,'POST','boards/resume-joins')
        self.assertEqual(result['results'][0]['host'],'c.example')
        self.assertEqual(result['results'][0]['status'],'joined')
        self.assertEqual(len(self.b.store.list('joined')),2)

    async def test_revocation_invalidates_outstanding_target_and_group_invitations(self):
        async def resolve(handle): return ['b.example','c.example']
        self.a.resolve=resolve
        await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'address':'fixture'})
        joined=await self.call(self.b,'POST','boards/join',{'host':'a.example','id':self.oid})
        # A second delivered grant must not survive removal of this group.
        await self.call(self.a,'POST',f'boards/{self.oid}/invites',{'address':'fixture'})
        unrelated=self.a.mint_invite(self.oid,'viewer',target='d.example')
        await self.call(self.a,'DELETE',f"boards/{self.oid}/members/{joined['membership']['member_id']}",query={'all_deployments':'true'})
        self.assertEqual(len(self.a.board(self.oid)['invites']),1)
        response=await self.call(self.services['c.example'],'POST','boards/join',{'host':'a.example','id':self.oid},status=403)
        self.assertEqual(response['code'],'invitation-expired')
        self.assertIn('invite',unrelated)

class TransportBoundary(unittest.IsolatedAsyncioTestCase):
    async def test_peer_policy_rejects_plaintext_and_userinfo_without_dns(self):
        from collaboration.net_utils import validate_url_safe, UnsafePeerAddress
        with patch('socket.getaddrinfo', side_effect=AssertionError('must reject before DNS')):
            for url in ('http://peer.example', 'https://name:password@peer.example'):
                with self.assertRaises(UnsafePeerAddress): validate_url_safe(url)

    async def test_service_import_does_not_load_a_web_framework(self):
        result = subprocess.run([sys.executable, '-c',
            "import service, sys; assert 'fastapi' not in sys.modules; assert 'starlette' not in sys.modules"],
            cwd=ROOT, env={'PATH':os.environ['PATH']}, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    async def test_private_and_mixed_dns_answers_are_rejected(self):
        from collaboration.net_utils import validate_url_safe, UnsafePeerAddress
        import socket
        for addresses in [('127.0.0.1',),('169.254.169.254',),('8.8.8.8','10.0.0.1'),('::ffff:127.0.0.1',),('64:ff9b::a9fe:a9fe',)]:
            with patch('socket.getaddrinfo',return_value=[(socket.AF_INET6 if ':' in a else socket.AF_INET,socket.SOCK_STREAM,6,'',(a,0)) for a in addresses]):
                with self.assertRaises(UnsafePeerAddress): validate_url_safe('https://peer.example/board')

    async def test_transport_pins_dns_preserves_identity_and_rejects_redirects(self):
        from collaboration.transport import federation_request, FederationTransportError
        RealClient=httpx.AsyncClient
        seen=[]
        async def handler(request):
            seen.append(request)
            return httpx.Response(302,headers={'location':'http://127.0.0.1/private'})
        def client(**kwargs):
            self.assertFalse(kwargs['trust_env']);self.assertFalse(kwargs['follow_redirects'])
            return RealClient(**kwargs,transport=httpx.MockTransport(handler))
        with patch('collaboration.transport.validate_url_safe',return_value=(['https://8.8.8.8/peer'],'peer.example','peer.example')),patch('collaboration.transport.httpx.AsyncClient',side_effect=client):
            with self.assertRaises(FederationTransportError): await federation_request('POST','https://peer.example/peer',json={'op':'state'})
        self.assertEqual(len(seen),1)
        self.assertEqual(seen[0].url.host,'8.8.8.8')
        self.assertEqual(seen[0].headers['host'],'peer.example')
        self.assertEqual(seen[0].extensions['sni_hostname'],'peer.example')

    async def test_transport_caps_response_and_requires_json_objects(self):
        from collaboration.transport import federation_request, FederationTransportError
        RealClient=httpx.AsyncClient
        for content,headers,limit in [(b'x'*200,{'content-type':'application/json'},100),(b'[]',{'content-type':'application/json'},100),(b'<html/>',{'content-type':'text/html'},100)]:
            async def handler(request): return httpx.Response(200,content=content,headers=headers)
            def client(**kwargs): return RealClient(**kwargs,transport=httpx.MockTransport(handler))
            with patch('collaboration.transport.validate_url_safe',return_value=(['https://8.8.8.8/peer'],'peer.example','peer.example')),patch('collaboration.transport.httpx.AsyncClient',side_effect=client):
                with self.assertRaises(FederationTransportError): await federation_request('POST','https://peer.example/peer',max_response_bytes=limit)
