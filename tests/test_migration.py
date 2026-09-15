"""Synthetic, explicit temporary roots only. No live service imports or traffic."""
import asyncio
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

import httpx
from collaboration.service import Service
from migration_tools.legacy_authority import LegacyAuthority, HandoffError, fingerprint
from migration_tools.import_board import stage, install_member, activate

ROOT=Path(__file__).resolve().parents[1]
OID='d'*32
TRANSITION='e'*32
DOC={'v':1,'title':'Legacy fixture','columns':[],'cards':{},'future':{'preserve':True}}

class Migration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.objects=self.root/'old'/'common'/'objects'
        self.board=self.objects/'hosted'/OID;self.board.mkdir(parents=True)
        self.members={'host.example':{'role':'editor','name':'Owner','host_owner':True}}
        for n in range(12):
            self.members[f'peer{n}.example']={'role':'viewer' if n==0 else 'editor',
                'pending':n>=7,'name':f'Member{n}','collaborator_id':'group' if n in (0,1) else str(n)}
        self.obj={'id':OID,'app':'kanban','kind':'board','label':'Legacy fixture','version':199,
                  'created_at':123,'members':self.members,'invites':{},'unknown_future':'retain'}
        (self.board/'object.json').write_text(json.dumps(self.obj))
        (self.board/'doc.json').write_text(json.dumps(DOC))
        (self.board/'assets').mkdir();(self.board/'assets'/'asset-one.txt').write_bytes(b'exact fixture bytes')
        self.authority=LegacyAuthority(self.objects,'host.example')
        self.services={}
        async def network(method,url,**kw):
            u=urlsplit(url)
            r=await self.services[u.hostname].handle({'method':method,'path':u.path.split('/kanban/')[1],
                'body':kw.get('json'),'actor':{'scope':'public'}})
            return httpx.Response(r['status'],json=r['body'])
        self.network=network
        self.host=self.service('host.example')

    def service(self,host):
        s=Service(self.root/'new'/host,host=host,app_id=7,request=self.network)
        self.services[host]=s;return s

    async def asyncTearDown(self):
        for s in self.services.values():s.close()
        self.temp.cleanup()

    def prepare(self):
        archive=self.authority.freeze(OID,TRANSITION)
        return archive,stage(self.host,self.authority,OID,'original-local-id')

    def install_all(self,grants):
        return [install_member(self.service(g['target']),g) for g in grants]

    async def call(self,s,path,method='GET',body=None):
        return await s.handle({'path':path,'method':method,'body':body,'actor':{'scope':'owner'}})

    async def test_preserves_all_members_pending_roles_version_document_and_assets(self):
        archive,grants=self.prepare();confirmations=self.install_all(grants)
        self.assertEqual(len(grants),12);self.assertEqual(sum(g['pending'] for g in grants),5)
        self.assertEqual(archive['object']['unknown_future'],'retain')
        self.assertEqual((await self.call(self.host,f'boards/host.example/{OID}/state'))['status'],409)
        self.assertEqual((await self.call(self.host,'boards'))['body']['hosted'],[])
        activate(self.host,self.authority,OID,confirmations)
        row=self.host.board(OID)
        self.assertEqual(row['doc'],DOC);self.assertEqual(row['version'],199)
        self.assertEqual(len(row['members']),13)
        self.assertEqual(sum(m.get('pending',False) for m in row['members'].values()),5)
        asset=self.host.store.get('asset',OID+'/asset-one')
        self.assertEqual(base64.b64decode(asset['data']),b'exact fixture bytes')
        self.assertNotIn('grants',self.host.store.get('migration',OID))
        peer=self.services['peer0.example']
        r=await self.call(peer,f'boards/host.example/{OID}/state','PUT',{'doc':DOC,'expected_version':199})
        self.assertEqual(r['status'],403);self.assertEqual(r['body']['code'],'read-only')
        peer=self.services['peer1.example']
        r=await self.call(peer,f'boards/host.example/{OID}/state','PUT',{'doc':{**DOC,'title':'New authority'},'expected_version':199})
        self.assertEqual(r['body']['version'],200)
        with self.assertRaises(HandoffError):
            with self.authority.request(f'objects/host.example/{OID}/state'):pass
        self.assertEqual(json.loads((self.board/'doc.json').read_text()),DOC)
        self.assertEqual(json.loads((self.board/'object.json').read_text())['version'],199)

    async def test_pending_invitation_requires_acceptance_and_never_auto_joins(self):
        _,grants=self.prepare();confirmations=self.install_all(grants)
        activate(self.host,self.authority,OID,confirmations)
        peer=self.services['peer7.example']
        self.assertEqual((await self.call(peer,'boards'))['body']['joined'],[])
        self.assertEqual((await self.call(peer,'boards/resume-joins','POST'))['body']['results'],[])
        invitations=(await self.call(peer,'boards/invitations'))['body']['invitations']
        self.assertEqual(len(invitations),1);self.assertNotIn('credential',json.dumps(invitations))
        grant=next(g for g in grants if g['target']=='peer7.example')
        raw=await self.host.handle({'method':'POST','path':'peer/'+OID,'body':{'protocol':'kanban/1',
            'op':'state','member_id':grant['member_id'],'credential':grant['credential']}})
        self.assertEqual(raw['body']['code'],'invitation-pending')
        joined=await self.call(peer,'boards/join','POST',{'id':OID,'host':'host.example'})
        self.assertEqual(joined['status'],200);self.assertEqual(joined['body']['version'],199)
        self.assertFalse(self.host.board(OID)['members'][grant['member_id']]['pending'])

    async def test_declined_migrated_invitation_cannot_be_recovered_as_an_automatic_join(self):
        _,grants=self.prepare();activate(self.host,self.authority,OID,self.install_all(grants))
        peer=self.services['peer8.example']
        await self.call(peer,f'boards/invitations/host.example/{OID}/decline','POST')
        grant=next(g for g in grants if g['target']=='peer8.example')
        install_member(peer,grant)  # Retry must not undo the later decline.
        self.assertEqual((await self.call(peer,'boards/resume-joins','POST'))['body']['results'],[])
        r=await self.call(peer,'boards/join','POST',{'id':OID,'host':'host.example'})
        self.assertEqual(r['status'],404)

    async def test_incomplete_or_wrong_member_receipt_cannot_enable_authority(self):
        _,grants=self.prepare();confirmations=self.install_all(grants)
        for bad in (confirmations[:-1],confirmations+[confirmations[0]],
                    [{**confirmations[0],'role':'editor'}]+confirmations[1:]):
            with self.assertRaises(HandoffError):activate(self.host,self.authority,OID,bad)
        self.assertTrue(self.host.store.get('board',OID)['staged'])
        with self.assertRaises(HandoffError):install_member(self.services['peer1.example'],grants[0])

    async def test_freeze_stage_install_activation_retries_survive_process_reopen(self):
        archive,grants=self.prepare()
        self.assertEqual(self.authority.freeze(OID,TRANSITION),archive)
        self.assertEqual(stage(self.host,self.authority,OID,'original-local-id'),grants)
        confirmations=self.install_all(grants)
        self.host.close();self.host=self.service('host.example')
        self.assertEqual(stage(self.host,self.authority,OID,'original-local-id'),grants)
        for g in grants:self.assertEqual(install_member(self.services[g['target']],g),next(r for r in confirmations if r['target']==g['target']))
        first=activate(self.host,self.authority,OID,confirmations)
        await self.call(self.host,f'boards/host.example/{OID}/state','PUT',{'doc':{**DOC,'title':'Later'},'expected_version':199})
        self.assertEqual(activate(self.host,self.authority,OID,confirmations),first)
        self.assertEqual(self.host.board(OID)['version'],200)
        with self.assertRaises(HandoffError):self.authority.freeze(OID,'f'*32)

    async def test_partial_snapshot_before_freeze_marker_does_not_retire_old_authority(self):
        from migration_tools import legacy_authority as module
        real=module.atomic_json
        def interrupted(path,value):
            if path==self.authority.marker(OID):raise OSError('fixture crash')
            real(path,value)
        with patch.object(module,'atomic_json',interrupted),self.assertRaises(OSError):
            self.authority.freeze(OID,TRANSITION)
        with self.authority.request(f'objects/{OID}/peer'):
            self.obj['version']=200
            (self.board/'object.json').write_text(json.dumps(self.obj))
        archive=self.authority.freeze(OID,TRANSITION)
        self.assertEqual(archive['object']['version'],200)

    async def test_tampered_source_or_receipt_blocks_activation(self):
        _,grants=self.prepare();confirmations=self.install_all(grants)
        (self.board/'doc.json').write_text(json.dumps({**DOC,'title':'Unexpected writer'}))
        with self.assertRaises(HandoffError):activate(self.host,self.authority,OID,confirmations)
        marker=self.authority.marker(OID);receipt=json.loads(marker.read_text());receipt['digest']='0'*64
        marker.write_text(json.dumps(receipt))
        with self.assertRaises(HandoffError):self.authority.verify(OID)

    async def test_bad_attachment_rolls_back_entire_staged_board(self):
        (self.board/'assets'/'asset-one.unknown').write_bytes(b'unknown')
        self.authority.freeze(OID,TRANSITION)
        with self.assertRaises(HandoffError):stage(self.host,self.authority,OID,'local')
        self.assertEqual(self.host.store.list('board'),[])
        self.assertEqual(self.host.store.list('asset'),[])
        self.assertEqual(self.host.store.list('migration'),[])

    async def test_grant_conflict_never_overwrites_an_existing_membership(self):
        _,grants=self.prepare();peer=self.service(grants[0]['target'])
        install_member(peer,grants[0])
        with self.assertRaises(HandoffError):install_member(peer,{**grants[0],'credential':'x'*43})
        self.assertEqual(peer.store.get('joined','host.example/'+OID)['credential'],grants[0]['credential'])

    async def test_frozen_route_gate_covers_writes_assets_grants_and_delete_not_social(self):
        self.authority.freeze(OID,TRANSITION)
        for path in (f'objects/{OID}/peer',f'objects/{OID}/peer-asset/a',f'objects/{OID}/invites',
                     f'objects/{OID}/members/peer.example',f'objects/{OID}',
                     f'objects/host.example/{OID}/state',f'objects/host.example/{OID}/assets/a'):
            with self.assertRaises(HandoffError):
                with self.authority.request(path):pass
        with self.authority.request('social/messages'):pass
        with self.authority.request('objects/'+'a'*32+'/peer'):pass

    async def test_cross_process_lease_excludes_freeze_until_writer_has_finished(self):
        code='''import sys,json
from migration_tools.legacy_authority import LegacyAuthority
from pathlib import Path
a=LegacyAuthority(sys.argv[1],'host.example')
with a.request('objects/'+sys.argv[2]+'/peer'):
 print('leased',flush=True);sys.stdin.readline()
 p=Path(sys.argv[1])/'hosted'/sys.argv[2]/'object.json'
 obj=json.loads(p.read_text());obj['version']=200;p.write_text(json.dumps(obj))
'''
        env={'PATH':os.environ['PATH'],'PYTHONPATH':str(ROOT)}
        proc=subprocess.Popen([sys.executable,'-c',code,str(self.objects),OID],env=env,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            self.assertEqual(await asyncio.wait_for(asyncio.to_thread(proc.stdout.readline),5),'leased\n')
            import fcntl
            with (self.authority.handoffs/'authority.lock').open('a') as lock:
                with self.assertRaises(BlockingIOError):fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            proc.stdin.write('finish\n');proc.stdin.flush()
            archive=await asyncio.wait_for(asyncio.to_thread(self.authority.freeze,OID,TRANSITION),5)
            self.assertEqual(archive['object']['version'],200)
            proc.wait(timeout=5);self.assertEqual(proc.returncode,0)
        finally:
            if proc.poll() is None:proc.kill();proc.wait()
            proc.stdin.close();proc.stdout.close();proc.stderr.close()

    async def test_prepared_legacy_dispatch_patch_enforces_retirement_in_a_fresh_json_process(self):
        import shutil
        source=self.root/'fixture-social-source';source.mkdir()
        shutil.copy2(ROOT/'tests/fixtures/legacy_service.py',source/'service.py')
        shutil.copy2(ROOT/'migration_tools/legacy_authority.py',source/'legacy_authority.py')
        applied=subprocess.run(['git','apply','--whitespace=error',str(ROOT/'migration_tools/legacy_patch/service.patch')],
            cwd=source,capture_output=True,text=True,timeout=5)
        self.assertEqual(applied.returncode,0,applied.stderr)
        (source/'service_runtime.py').write_text('''import os
from pathlib import Path
from types import SimpleNamespace
def migrate_legacy_state():pass
def reset_actor(token):pass
def set_actor(actor):return None
def get_settings():return SimpleNamespace(domain='host.example')
''')
        # Stub only domain handlers; execute the exact old entry and patch
        # through actual FastAPI/httpx and a fresh JSON-v1 subprocess.
        (source/'social_objects.py').write_text('''import os
from pathlib import Path
from fastapi import APIRouter
router=APIRouter(prefix='/objects')
def _objects_dir():return Path(os.environ['FIXTURE_OBJECTS'])
@router.put('/{host}/{oid}/state')
def write(host:str,oid:str):
 (_objects_dir()/'write-reached').write_text('fixture')
 return {'status':'handler-reached'}
''')
        for name in ('social_groups','social_routes'):
            (source/(name+'.py')).write_text('from fastapi import APIRouter\nrouter=APIRouter()\n')
        env={'PATH':os.environ['PATH'],'FIXTURE_OBJECTS':str(self.objects)}
        def invoke():
            r=subprocess.run([sys.executable,str(source/'service.py')],env=env,
                input=json.dumps({'method':'PUT','path':f'objects/host.example/{OID}/state',
                                  'actor':{'scope':'owner'},'body':{'doc':DOC}}),
                capture_output=True,text=True,timeout=10,check=True)
            return json.loads(r.stdout)
        self.assertEqual(invoke()['status'],200)
        (self.objects/'write-reached').unlink()  # Own disposable test fixture.
        self.authority.freeze(OID,TRANSITION)
        result=invoke()
        self.assertEqual(result['status'],409)
        self.assertEqual(result['body']['code'],'authority-retired')
        self.assertFalse((self.objects/'write-reached').exists())

    async def test_original_unredeemed_invite_keeps_its_role_and_expiry(self):
        import hashlib,time
        secret='fixture-old-invite-'+('x'*20)
        expiry=time.time()+3600
        self.obj['invites']={hashlib.sha256(secret.encode()).hexdigest():{'role':'viewer','expires_at':expiry,'created_at':123}}
        (self.board/'object.json').write_text(json.dumps(self.obj))
        _,grants=self.prepare();activate(self.host,self.authority,OID,self.install_all(grants))
        self.assertEqual(self.host.board(OID)['invites'],self.obj['invites'])
        peer=self.service('new-visitor.example')
        result=await self.call(peer,'boards/join','POST',{'invite':f'{OID}@host.example#{secret}'})
        self.assertEqual(result['status'],200)
        self.assertEqual(result['body']['membership']['role'],'viewer')
        self.assertEqual(self.host.board(OID)['invites'],{})
