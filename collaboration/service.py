"""Kanban's independent, capability-authorized board service.

Host HTTPS authenticates the board authority. A random credential authorizes
one admitted member of one board; roles always come from the host transaction,
never a claimed host/name or a client-supplied role. Credentials travel only
in bounded HTTPS POST bodies and stay in server-side membership records.
There are no Social keys, messages, imports, callback key lookups or live-data
migration side effects. Public invitation delivery is explicitly unverified
until the recipient chooses to redeem it against the claimed HTTPS authority.
"""
import asyncio
import base64
import hashlib
import json
import re
import secrets
import time
import uuid
from urllib.parse import quote, unquote

from .store import Store
from .transport import federation_request

PROTOCOL = 'kanban/1'
SERVICE_ID = 'kanban'  # Stable public service identity, not a display name.
ID = re.compile(r'^[a-f0-9]{32}$')
HOST = re.compile(r'^[a-z0-9](?:[a-z0-9.-]{0,250}[a-z0-9])?(?::[0-9]{1,5})?$')
SECRET = re.compile(r'^[A-Za-z0-9_-]{32,128}$')
ASSET = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
MAX_DOC = 256 * 1024
MAX_ASSET = 5 * 1024 * 1024
PRESENCE_TTL = 12
INVITE_TTL = 7 * 86400


class Failure(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


def fail(status, code, message):
    raise Failure(status, code, message)


def check(value, pattern, name):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        fail(400, 'invalid-request', f'Invalid {name}.')
    return value


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def document(doc):
    if not isinstance(doc, dict) or not isinstance(doc.get('columns'), list) or not isinstance(doc.get('cards'), dict):
        fail(400, 'invalid-board', 'A board must contain columns and cards.')
    try:
        raw = json.dumps(doc, allow_nan=False).encode()
    except (ValueError, TypeError):
        fail(400, 'invalid-board', 'The board is not valid JSON.')
    if len(raw) > MAX_DOC:
        fail(413, 'board-too-large', 'The board is too large.')
    return doc


class Service:
    def __init__(self, root, *, host, app_id, request=federation_request, resolve=None, now=time.time):
        self.store = Store(root)
        self.host = check(host, HOST, 'instance host')
        self.app_id = app_id
        self.request = request
        self.resolve = resolve
        self.now = now

    def close(self):
        self.store.close()

    def owner(self, actor, *, write=False):
        if actor.get('scope') not in ('owner', 'app') or (actor.get('scope') == 'app' and actor.get('app_id') != self.app_id):
            fail(403, 'wrong-principal', 'Only this Kanban app or its owner may do that.')
        if write and actor.get('delegated'):
            fail(403, 'delegated-action', 'This action requires the owner, not a delegated agent.')

    def board(self, oid):
        check(oid, ID, 'board id')
        row = self.store.get('board', oid)
        if not row:
            fail(404, 'board-missing', 'The board does not exist at this authority.')
        if row.get('staged'):
            fail(409, 'migration-staged', 'The board handoff is not active. Pending edits are retained.')
        if row.get('retired'):
            fail(409, 'authority-retired', 'This board authority has been retired. Pending edits are retained.')
        return row

    def public(self, row):
        members = {}
        for key, member in row['members'].items():
            last = member.get('seen', 0)
            members[key] = {k:v for k,v in member.items() if k in ('host','name','handle','role','pending','collaborator_id','host_owner')}
            members[key]['member_id'] = key
            members[key]['active'] = not member.get('pending') and 0 <= self.now()-last <= PRESENCE_TTL
        return {'handoff':row.get('handoff'), 'local_id':row.get('local_id'), 'id':row['id'], 'host':self.host, 'app':'kanban', 'kind':'board', 'label':row['label'], 'version':row['version'], 'members':members, 'transport':PROTOCOL}

    def member(self, row, member_id, credential):
        check(member_id, ID, 'member id')
        check(credential, SECRET, 'member credential')
        m = row['members'].get(member_id)
        if not m or not secrets.compare_digest(m.get('credential_hash',''), digest(credential)):
            fail(403, 'membership-revoked', 'This board credential is not authorized.')
        return m

    def state(self, row, since=-1):
        result = {'status':'ok', 'version':row['version'], 'object':self.public(row)}
        if row['version'] > since:
            result['doc'] = row['doc']
        return result

    async def remote(self, host, oid, payload):
        check(host, HOST, 'board host'); check(oid, ID, 'board id')
        try:
            response = await self.request('POST', f'https://{host}/api/app-services/{SERVICE_ID}/peer/{oid}', json={'protocol':PROTOCOL, **payload}, max_response_bytes=8*1024*1024, timeout_seconds=10)
        except Exception as exc:
            raise Failure(502, 'authority-unavailable', 'The board host could not be reached. Pending edits are retained.') from exc
        try:
            data = response.json()
        except Exception:
            fail(502, 'authority-unavailable', 'The board host returned an invalid response.')
        # A gateway 404/403 does not establish deletion or revocation.
        if not isinstance(data, dict) or data.get('protocol') != PROTOCOL:
            fail(502, 'authority-unavailable', 'The remote Kanban service is unavailable or needs updating.')
        if response.status_code >= 400:
            code = data.get('code')
            if not isinstance(code, str):
                fail(502, 'authority-unavailable', 'The remote Kanban service could not confirm the request.')
            fail(response.status_code, code, str(data.get('detail') or 'The board host refused the request.'))
        return data

    def new_board(self, body):
        doc = document(body.get('doc'))
        if body.get('app', 'kanban') != 'kanban':
            fail(403, 'wrong-app', 'This service owns Kanban boards only.')
        oid = check(body['id'], ID, 'board id') if body.get('id') else uuid.uuid4().hex
        local_id = body.get('local_id')
        if local_id is not None and (not isinstance(local_id,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,199}',local_id)):
            fail(400,'invalid-local-id','Invalid local board identity.')
        row = {'id':oid,'local_id':local_id,'label':str(body.get('label') or doc.get('title') or 'Board')[:120], 'doc':doc,'version':1,
               'members':{self.host:{'host':self.host,'name':'Board owner','role':'editor','host_owner':True,'seen':self.now()}}, 'invites':{}}
        with self.store.transaction():
            existing = self.store.get('board',oid)
            if existing:
                if existing.get('staged'):
                    fail(409,'migration-staged','The board handoff is not active.')
                if not local_id or existing.get('local_id') != local_id:
                    fail(409,'board-id-conflict','This identity already names another board.')
                return {'id':oid,'host':self.host,'version':existing['version'],'transport':PROTOCOL}
            self.store.put('board',oid,row)
        return {'id':oid,'host':self.host,'version':1,'transport':PROTOCOL}

    def mint_invite(self, oid, role, *, target=None, group=None, ttl=INVITE_TTL):
        return self.mint_grants(oid, role, [target], group=group, ttl=ttl)[0]

    def mint_grants(self, oid, role, targets, *, group=None, ttl=INVITE_TTL):
        if role not in ('editor','viewer'):
            fail(400,'invalid-role','Role must be editor or viewer.')
        if type(ttl) is not int or not 1 <= ttl <= INVITE_TTL:
            fail(400,'invalid-expiry','Invitations expire within seven days.')
        grants = []
        with self.store.transaction():
            row = self.board(oid)
            row['invites'] = {k:v for k,v in row['invites'].items() if v['expires_at'] > self.now()}
            if len(row['invites']) + len(targets) > 100:
                fail(429,'invitations-full','This board has too many outstanding invitations.')
            expires = self.now() + ttl
            for target in targets:
                secret = secrets.token_urlsafe(32)
                row['invites'][digest(secret)] = {'role':role, 'expires_at':expires, 'target':target, 'group':group}
                grants.append({'invite':f'{oid}@{self.host}#{secret}', 'role':role, 'expires_at':expires})
            self.store.put('board',oid,row)
        return grants

    async def invite(self, oid, body):
        role = body.get('role','editor')
        if not body.get('address'):
            return self.mint_invite(oid,role,ttl=body.get('ttl_seconds',INVITE_TTL))
        address = str(body['address']).strip().lower().lstrip('@')
        group = None
        if '@' in address or '.' in address:
            hosts = [check(address.rsplit('@',1)[-1],HOST,'recipient address')]
        else:
            if not self.resolve:
                fail(503,'identity-unavailable','Handle lookup is unavailable. Use a full deployment address.')
            hosts = await self.resolve(address)
            if not hosts:
                fail(404,'identity-missing','That handle has no linked deployments.')
            hosts = list(dict.fromkeys(check(h,HOST,'linked deployment') for h in hosts))
            group = digest('registry:'+address)
        if len(hosts) > 20 or self.host in hosts:
            fail(400,'invalid-recipients','Choose other deployments, up to twenty at once.')
        # Mint the bounded batch atomically before any delivery, then overlap
        # independent network waits. One slow recipient must not starve later
        # recipients until the platform's per-request lifetime expires.
        meta = self.public(self.board(oid))
        grants = self.mint_grants(oid, role, hosts, group=group)
        async def deliver(host, minted):
            try:
                response = await self.request('POST',f'https://{host}/api/app-services/{SERVICE_ID}/invitations/deliver',
                    json={'protocol':PROTOCOL,'invite':minted['invite'],'label':meta['label'],'role':role}, max_response_bytes=32768, timeout_seconds=10)
                valid = response.status_code == 200 and response.json().get('protocol') == PROTOCOL
            except Exception:
                valid = False
            return {'host':host,'delivery':'delivered' if valid else 'unreachable'}
        results = await asyncio.gather(*(deliver(host, minted) for host, minted in zip(hosts, grants)))
        count = sum(item['delivery']=='delivered' for item in results)
        return {'status':'invited','role':role,'recipients':results,'delivery':'delivered' if count==len(results) else 'partial' if count else 'unreachable','members':self.public(self.board(oid))['members']}

    def parse_invite(self, raw):
        try:
            address, secret = raw.split('#')
            oid, host = address.split('@')
            return check(oid,ID,'board id'),check(host,HOST,'board host'),check(secret,SECRET,'invitation')
        except (ValueError,AttributeError):
            fail(400,'invalid-invitation','The invitation is malformed.')

    def receive(self, body):
        oid,host,secret = self.parse_invite(body.get('invite'))
        key = host+'/'+oid
        with self.store.transaction():
            previous = self.store.get('invitation',key)
            declined={k:v for k,v in (previous or {}).get('declined_tokens',{}).items() if v>self.now()}
            if digest(secret) in declined or (previous and previous.get('invite')==body['invite']):
                return {'status':'delivered'}
            if len(declined)>=100:
                fail(429,'invitations-full','Invitation history for this board is full.')
            if previous is None and len(self.store.list('invitation')) >= 100:
                fail(429,'invitations-full','The invitation inbox is full.')
            self.store.put('invitation',key,{'id':oid,'host':host,'invite':body['invite'],'label':str(body.get('label') or 'Board')[:120],
                'role':body.get('role') if body.get('role') in ('editor','viewer') else 'viewer','status':'pending','received_at':self.now(), 'verified':False,'declined_tokens':declined})
        return {'status':'delivered'}

    async def join(self, body):
        raw = body.get('invite')
        if not raw:
            key = check(body.get('host'),HOST,'host')+'/'+check(body.get('id'),ID,'board id')
            pending = self.store.get('joined',key)
            invitation = self.store.get('invitation',key)
            if pending and pending.get('status') in ('joining','invited'):
                raw = pending['id']+'@'+pending['host']+'#'+pending.get('invite',pending['credential'])
            elif not invitation or invitation['status'] != 'pending':
                fail(404,'invitation-missing','No pending invitation.')
            else: raw = invitation['invite']
        oid,host,secret = self.parse_invite(raw)
        if host == self.host:
            fail(400,'already-hosted','This board is already hosted here.')
        key = host+'/'+oid
        # Persist the retry identity BEFORE host admission. A lost response or
        # a process exit after admission can retry without consuming a new invite.
        with self.store.transaction():
            member = self.store.get('joined',key)
            if not member or member.get('status') == 'revoked':
                member = {'id':oid,'host':host,'member_id':uuid.uuid4().hex,'credential':secrets.token_urlsafe(32),'status':'joining','invite':secret}
                self.store.put('joined',key,member)
            elif member.get('status') == 'invited':
                member['status']='joining'
                self.store.put('joined',key,member)
            elif member.get('status') == 'joining' and member.get('invite') != secret:
                member['invite']=secret
                self.store.put('joined',key,member)
        result = await self.remote(host,oid,{'op':'join','member_id':member['member_id'],'credential':member['credential'],
            'invite':member.get('invite',secret),'host':self.host})
        meta = result.get('object',{})
        admitted = meta.get('members',{}).get(member['member_id'])
        if not admitted or admitted.get('role') not in ('editor','viewer'):
            fail(502,'invalid-membership','The board host returned invalid membership.')
        member.update(status='joined',role=admitted['role'],label=meta.get('label','Board'),transport=PROTOCOL)
        member.pop('invite',None)
        with self.store.transaction():
            self.store.put('joined',key,member)
            self.store.delete('invitation',key)
        return {'status':'joined','membership':self.membership(member),'doc':result['doc'],'version':result['version']}

    async def resume_join(self):
        # A durable round-robin cursor bounds one request to one remote attempt
        # without letting an unavailable first host starve every later join.
        # Claim the next position before network I/O, including across restarts.
        with self.store.transaction():
            pending = sorted((m for m in self.store.list('joined') if m['status']=='joining'),
                             key=lambda m: m['host']+'/'+m['id'])
            if not pending:
                self.store.delete('recovery','join-cursor')
                return {'results':[]}
            cursor = (self.store.get('recovery','join-cursor') or {}).get('key','')
            member = next((m for m in pending if m['host']+'/'+m['id'] > cursor),pending[0])
            self.store.put('recovery','join-cursor',{'key':member['host']+'/'+member['id']})
        result={'id':member['id'],'host':member['host']}
        try:
            await self.join({'host':member['host'],'id':member['id']})
            result['status']='joined'
        except Failure as error:
            result.update(status='unavailable',code=error.code)
        return {'results':[result]}

    @staticmethod
    def membership(member):
        return {k:v for k,v in member.items() if k not in ('credential','invite')}

    def peer(self, oid, body):
        op = body.get('op')
        with self.store.transaction():
            row = self.board(oid)
            mid = check(body.get('member_id'),ID,'member id')
            credential = check(body.get('credential'),SECRET,'member credential')
            if op == 'join':
                existing = row['members'].get(mid)
                if existing:
                    self.member(row,mid,credential)
                    existing['pending']=False;existing['seen']=self.now()
                    self.store.put('board',oid,row)
                    return self.state(row)
                secret = check(body.get('invite'),SECRET,'invitation')
                inv = row['invites'].get(digest(secret))
                if not inv or inv['expires_at'] <= self.now():
                    fail(403,'invitation-expired','The invitation is invalid or expired.')
                claimed_host = check(body.get('host'),HOST,'member address')
                # Host/name is a locator, NOT authorization. Possession of this
                # single-use invite admits the exact credential. Never merge
                # a member into an existing principal by a claimed host/name.
                if len(row['members'])>=500:
                    fail(429,'members-full','This board has reached its member limit.')
                row['members'][mid] = {'host':claimed_host,'name':claimed_host,'role':inv['role'],
                    'credential_hash':digest(credential),'seen':self.now(),
                    **({'collaborator_id':inv['group']} if inv.get('group') else {})}
                if inv.get('target') and inv['target'] != claimed_host:
                    fail(403,'wrong-invitation-target','This invitation names a different deployment.')
                row['invites'].pop(digest(secret))
                self.store.put('board',oid,row)
                return self.state(row)
            member = self.member(row,mid,credential)
            if op != 'leave' and member.get('pending'):
                fail(409,'invitation-pending','Accept the invitation before using this board.')
            if op == 'leave':
                row['members'].pop(mid)
                self.store.put('board',oid,row)
                return {'status':'left'}
            if op not in ('state','write','asset-read','asset-write','asset-delete'):
                fail(400,'invalid-operation','Unsupported board operation.')
            if op in ('write','asset-write','asset-delete') and member['role'] != 'editor':
                fail(403,'read-only','This board member is a viewer.')
            member['seen'] = self.now()
            result = self.operation(row,op,body)
            self.store.put('board',oid,row)
            return result

    def operation(self, row, op, body):
        if op == 'state':
            since = body.get('since_version',-1)
            if type(since) is not int: fail(400,'invalid-version','Version must be an integer.')
            return self.state(row,since)
        if op == 'write':
            doc = document(body.get('doc'))
            expected = body.get('expected_version')
            if type(expected) is not int or expected < 1:
                fail(400,'invalid-version','Expected version must be a positive integer.')
            if expected != row['version']:
                return {'status':'conflict','version':row['version'],'doc':row['doc']}
            row['doc']=doc; row['version']+=1
            row['label']=str(doc.get('title') or row['label'])[:120]
            return {'status':'ok','version':row['version']}
        aid = check(body.get('asset_id'),ASSET,'asset id')
        key = row['id']+'/'+aid
        if op == 'asset-read':
            asset = self.store.get('asset',key)
            if not asset: fail(404,'asset-missing','Attachment not found.')
            return {'status':'ok','asset':asset}
        if op == 'asset-delete':
            self.store.delete('asset',key)
            return {'status':'deleted'}
        mime,data=body.get('mime'),body.get('data')
        if not isinstance(mime,str) or not re.fullmatch(r'[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+',mime) or len(mime)>120:
            fail(400,'invalid-asset','Invalid attachment type.')
        if not isinstance(data,str) or len(data)>4*((MAX_ASSET+2)//3):
            fail(413,'asset-too-large','Attachment is too large.')
        try: decoded=base64.b64decode(data,validate=True)
        except ValueError: fail(400,'invalid-asset','Invalid attachment encoding.')
        if not decoded or len(decoded)>MAX_ASSET:
            fail(413,'asset-too-large','Attachment is empty or too large.')
        assets = [a for a in self.store.list('asset') if a['board_id']==row['id'] and a['id']!=aid]
        if len(assets)>=100 or sum(a['bytes'] for a in assets)+len(decoded)>100*1024*1024:
            fail(413,'assets-full','Board attachment limit reached.')
        self.store.put('asset',key,{'id':aid,'board_id':row['id'],'mime':mime,'data':data,'bytes':len(decoded)})
        return {'status':'ok'}

    async def state_operation(self, host, oid, op, body):
        check(host,HOST,'board host'); check(oid,ID,'board id')
        if host == self.host:
            with self.store.transaction():
                row = self.board(oid)
                row['members'][self.host]['seen'] = self.now()
                result = self.operation(row,op,body)
                self.store.put('board',oid,row)
                return result
        member = self.store.get('joined',host+'/'+oid)
        if not member or member['status']!='joined':
            fail(409,'membership-unavailable','This board has not been joined or migrated to independent Kanban.')
        try:
            return await self.remote(host,oid,{'op':op,'member_id':member['member_id'],'credential':member['credential'],**body})
        except Failure as error:
            if error.code == 'membership-revoked':
                with self.store.transaction():
                    current=self.store.get('joined',host+'/'+oid)
                    if current and current['member_id']==member['member_id']:
                        current['status']='revoked'
                        self.store.put('joined',host+'/'+oid,current)
            raise

    async def handle(self, request):
        try:
            body=request.get('body') or {}
            if not isinstance(body,dict): fail(400,'invalid-request','Request must be an object.')
            path=[unquote(p) for p in str(request.get('path','')).strip('/').split('/') if p]
            method=request.get('method','GET').upper()
            actor=request.get('actor') or {'scope':'public'}
            query=request.get('query') or {}
            def query_value(name,default=None):
                v=query.get(name,default)
                return v[-1] if isinstance(v,list) and v else v
            if path==['health'] and method=='GET':
                result={'status':'ok','service':SERVICE_ID,'host':self.host}
            elif path==['invitations','deliver'] and method=='POST':
                if body.get('protocol')!=PROTOCOL: fail(400,'invalid-protocol','Unsupported collaboration protocol.')
                result=self.receive(body)
            elif len(path)==2 and path[0]=='peer' and method=='POST':
                if body.get('protocol')!=PROTOCOL: fail(400,'invalid-protocol','Unsupported collaboration protocol.')
                result=self.peer(path[1],body)
            else:
                self.owner(actor,write=method!='GET')
                if not path or path[0]!='boards': fail(404,'route-missing','No such Kanban route.')
                p=path[1:]
                if not p and method=='POST': result=self.new_board(body)
                elif not p and method=='GET':
                    result={'hosted':[self.public(r) for r in self.store.list('board') if not r.get('retired') and not r.get('staged')],
                        'joined':[self.membership(m) for m in self.store.list('joined') if m['status']=='joined']}
                elif p==['join'] and method=='POST': result=await self.join(body)
                elif p==['resume-joins'] and method=='POST':
                    result=await self.resume_join()
                elif p==['invitations'] and method=='GET':
                    result={'invitations':[{k:v for k,v in i.items() if k not in ('invite','declined_tokens')} for i in self.store.list('invitation') if i['status']=='pending']}
                elif len(p)==4 and p[0]=='invitations' and p[3]=='decline' and method=='POST':
                    key=check(p[1],HOST,'host')+'/'+check(p[2],ID,'board id')
                    with self.store.transaction():
                        inv=self.store.get('invitation',key)
                        if inv:
                            _,_,secret=self.parse_invite(inv['invite'])
                            inv.setdefault('declined_tokens',{})[digest(secret)]=self.now()+INVITE_TTL
                            inv['status']='declined'
                            self.store.put('invitation',key,inv)
                            pending=self.store.get('joined',key)
                            if pending and pending.get('status')=='invited':
                                self.store.delete('joined',key)
                    result={'status':'declined'}
                elif len(p)==2 and p[1]=='invites' and method=='POST': result=await self.invite(p[0],body)
                elif len(p)==2 and p[1]=='members' and method=='GET': result=self.public(self.board(p[0]))
                elif len(p)==3 and p[1]=='members' and method=='DELETE':
                    with self.store.transaction():
                        row=self.board(p[0]); mid=p[2]
                        if mid==self.host: fail(400,'owner-removal','The host cannot remove itself.')
                        if mid not in row['members']: fail(404,'member-missing','Member not found.')
                        group=row['members'][mid].get('collaborator_id')
                        removed=[key for key,m in row['members'].items() if key==mid or (query_value('all_deployments')=='true' and group and m.get('collaborator_id')==group)]
                        targets={row['members'][key]['host'] for key in removed}
                        for key in removed:
                            if key==self.host: fail(400,'owner-removal','The host cannot remove itself.')
                            row['members'].pop(key)
                        # Revocation includes still-unredeemed grants to the
                        # removed deployment(s), or the exact registry group.
                        # Otherwise an older invite could silently restore access.
                        all_group=query_value('all_deployments')=='true' and group
                        row['invites']={key:inv for key,inv in row['invites'].items()
                            if inv.get('target') not in targets and not (all_group and inv.get('group')==group)}
                        self.store.put('board',p[0],row)
                    result={'status':'revoked','hosts':removed}
                elif len(p)==1 and method=='DELETE':
                    with self.store.transaction():
                        oid=check(p[0],ID,'board id')
                        existing=self.store.get('board',oid)
                        if existing and existing.get('staged'):
                            fail(409,'migration-staged','The board handoff is not active.')
                        self.store.delete('board',oid)
                        for asset in self.store.list('asset'):
                            if asset['board_id']==oid: self.store.delete('asset',oid+'/'+asset['id'])
                    result={'status':'deleted'}
                elif len(p)==3 and p[2]=='leave' and method=='POST':
                    host,oid=p[:2]; key=check(host,HOST,'host')+'/'+check(oid,ID,'board id')
                    member=self.store.get('joined',key)
                    if member:
                        try: await self.remote(host,oid,{'op':'leave','member_id':member['member_id'],'credential':member['credential']})
                        except Failure as e:
                            if e.code not in ('membership-revoked','board-missing'): raise
                        with self.store.transaction(): self.store.delete('joined',key)
                    result={'status':'left'}
                elif len(p)==3 and p[2]=='state' and method in ('GET','PUT'):
                    if method=='GET':
                        try: body={'since_version':int(query_value('since_version',-1))}
                        except (ValueError,TypeError): fail(400,'invalid-version','Invalid version.')
                    result=await self.state_operation(p[0],p[1],'state' if method=='GET' else 'write',body)
                elif len(p)==4 and p[2]=='assets' and method in ('GET','PUT','DELETE'):
                    result=await self.state_operation(p[0],p[1],{'GET':'asset-read','PUT':'asset-write','DELETE':'asset-delete'}[method],{**body,'asset_id':p[3]})
                else: fail(404,'route-missing','No such Kanban route.')
            return {'status':200,'body':{'protocol':PROTOCOL,**result},'headers':{'cache-control':'no-store'}}
        except Failure as e:
            return {'status':e.status,'body':{'protocol':PROTOCOL,'code':e.code,'detail':e.message},'headers':{'cache-control':'no-store'}}
