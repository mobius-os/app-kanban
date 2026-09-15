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
from migration_tools.legacy_authority import LegacyAuthority, HandoffError
from migration_tools.import_board import stage, activate

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

    async def call(self,s,path,method='GET',body=None):
        return await s.handle({'path':path,'method':method,'body':body,'actor':{'scope':'owner'}})

    async def test_freeze_stage_activation_retries_survive_process_reopen(self):
        archive,receipt=self.prepare()
        self.assertEqual(self.authority.freeze(OID,TRANSITION),archive)
        self.assertEqual(stage(self.host,self.authority,OID,'original-local-id'),receipt)
        self.host.close();self.host=self.service('host.example')
        self.assertEqual(stage(self.host,self.authority,OID,'original-local-id'),receipt)
        first=activate(self.host,self.authority,OID)
        await self.call(self.host,f'boards/host.example/{OID}/state','PUT',{'doc':{**DOC,'title':'Later'},'expected_version':199})
        self.assertEqual(activate(self.host,self.authority,OID),first)
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
        self.prepare()
        (self.board/'doc.json').write_text(json.dumps({**DOC,'title':'Unexpected writer'}))
        with self.assertRaises(HandoffError):activate(self.host,self.authority,OID)
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

    async def test_host_can_activate_without_any_collaborator_and_preserves_backup(self):
        archive,receipt=self.prepare()
        self.assertEqual(receipt['reinvite_count'],12)
        self.assertEqual(len(archive['object']['members']),13)
        self.assertEqual(sum(m.get('pending',False) for m in archive['object']['members'].values()),5)
        self.assertEqual(archive['object']['unknown_future'],'retain')
        self.assertEqual((await self.call(self.host,'boards'))['body']['hosted'],[])
        activate(self.host,self.authority,OID)
        row=self.host.board(OID)
        self.assertEqual(row['doc'],DOC);self.assertEqual(row['version'],199)
        self.assertEqual(list(row['members']),['host.example'])
        self.assertEqual(row['invites'],{})
        self.assertEqual(base64.b64decode(self.host.store.get('asset',OID+'/asset-one')['data']),b'exact fixture bytes')
        self.assertEqual(self.authority.verify(OID),archive)

    async def test_late_collaborator_rejoins_with_a_fresh_invite(self):
        self.prepare();activate(self.host,self.authority,OID)
        invite=(await self.call(self.host,f'boards/{OID}/invites','POST',{'role':'viewer'}))['body']['invite']
        peer=self.service('late.example')
        result=await self.call(peer,'boards/join','POST',{'invite':invite})
        self.assertEqual(result['status'],200)
        self.assertEqual(result['body']['doc'],DOC)
        self.assertEqual(result['body']['membership']['role'],'viewer')
        denied=await self.call(peer,f'boards/host.example/{OID}/state','PUT',{'doc':DOC,'expected_version':199})
        self.assertEqual(denied['status'],403)
