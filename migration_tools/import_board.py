"""Stage/activate one frozen board and install its per-deployment grants.

Administrative library, not a public service endpoint. Call only against explicit
roots after approval. Transfer returned grants through authenticated owner
channels, never stdout/chat/browser storage. No live path or network defaults.
"""
import base64
import hashlib
import hmac
import re
import secrets
import uuid

from collaboration.service import PROTOCOL, ASSET, HOST, ID, SECRET, check, document, digest
from .legacy_authority import HandoffError, canonical, fingerprint

EXT_MIME = dict(zip(
    'jpg png webp gif pdf txt md csv json zip doc xls ppt docx xlsx pptx bin'.split(),
    ['image/jpeg','image/png','image/webp','image/gif','application/pdf','text/plain',
     'text/markdown','text/csv','application/json','application/zip','application/msword',
     'application/vnd.ms-excel','application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'application/octet-stream']))


def receipt(grant):
    public={k:grant[k] for k in ('transition','digest','id','host','target','member_id','role','pending')}
    return {**public,'proof':hmac.new(grant['credential'].encode(),canonical(public),hashlib.sha256).hexdigest()}


def stage(service, authority, oid, local_id):
    """Return protected grants; repeat preserves exact credentials and data."""
    if not isinstance(local_id,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,199}',local_id):
        raise HandoffError('Explicit local board identity is required.')
    with authority.lease(exclusive=True):
        archive=authority.verify(oid)
        if archive['host'] != service.host:
            raise HandoffError('A different deployment cannot assume this authority.')
        obj=archive['object'];doc=document(archive['doc']); sha=fingerprint(archive)
        if type(obj.get('version')) is not int or obj['version']<1:
            raise HandoffError('Invalid legacy version.')
        old_members=obj.get('members')
        if not isinstance(old_members,dict) or not old_members or len(old_members)>500:
            raise HandoffError('Legacy member inventory needs review.')
        owner=old_members.get(service.host,{})
        if owner.get('host_owner') is not True or owner.get('role')!='editor' or owner.get('pending'):
            raise HandoffError('The snapshot does not establish this board owner.')
        with service.store.transaction():
            previous=service.store.get('migration',oid)
            if previous:
                if previous['digest']!=sha or previous['local_id']!=local_id:
                    raise HandoffError('Another handoff already owns this identity.')
                return previous.get('grants',[])
            if service.store.get('board',oid):
                raise HandoffError('Refusing to replace an existing Kanban board.')
            members={};grants=[]
            for host,m in old_members.items():
                check(host,HOST,'legacy member host')
                if m.get('role') not in ('editor','viewer') or (m.get('host_owner') and host!=service.host):
                    raise HandoffError('Unrecognized legacy grant; no role was guessed.')
                member={k:v for k,v in m.items() if k in ('name','handle','role','collaborator_id')}
                member.update(host=host,pending=bool(m.get('pending')),seen=0)
                if host==service.host:
                    member['host_owner']=True;members[host]=member;continue
                mid=uuid.uuid4().hex;credential=secrets.token_urlsafe(32)
                member['credential_hash']=digest(credential);members[mid]=member
                grants.append({'transition':archive['transition'],'digest':sha,'id':oid,'host':service.host,
                    'target':host,'member_id':mid,'credential':credential,'role':m['role'],
                    'pending':member['pending'],'label':obj.get('label','Board')})
            invites=obj.get('invites') or {}
            for key,inv in invites.items():
                if (not re.fullmatch(r'[a-f0-9]{64}',key) or inv.get('role') not in ('editor','viewer')
                    or type(inv.get('expires_at')) not in (int,float)):
                    raise HandoffError('Unrecognized legacy invitation; no grant was dropped.')
            seen=set()
            for asset in archive['assets']:
                aid,ext=asset['filename'].rsplit('.',1)
                check(aid,ASSET,'attachment id')
                if ext not in EXT_MIME or aid in seen:
                    raise HandoffError('Ambiguous legacy attachment identity.')
                raw=base64.b64decode(asset['data'],validate=True)
                if hashlib.sha256(raw).hexdigest()!=asset['sha256']:
                    raise HandoffError('Attachment checksum mismatch.')
                seen.add(aid)
                service.store.put('asset',oid+'/'+aid,{'id':aid,'board_id':oid,'mime':EXT_MIME[ext],
                    'data':asset['data'],'bytes':len(raw)})
            row={'id':oid,'local_id':local_id,'label':obj.get('label','Board'),'doc':doc,'version':obj['version'],
                 'members':members,'invites':invites,'staged':True,
                 'handoff':{'from':'common/0','transition':archive['transition'],'digest':sha}}
            service.store.put('board',oid,row)
            service.store.put('migration',oid,{'phase':'staged','digest':sha,'local_id':local_id,'grants':grants})
            return grants


def install_member(service, grant):
    """Explicit owner-side install; pending grants stay invitations, not joins."""
    patterns = {'transition': ID, 'digest': re.compile(r'^[a-f0-9]{64}$'),
                'id': ID, 'host': HOST, 'target': HOST, 'member_id': ID, 'credential': SECRET}
    if (not isinstance(grant, dict)
        or any(not isinstance(grant.get(key), str) or not pattern.fullmatch(grant[key])
               for key, pattern in patterns.items())
        or grant.get('role') not in ('editor', 'viewer')
        or type(grant.get('pending')) is not bool
        or not isinstance(grant.get('label'), str)):
        raise HandoffError('Invalid handoff grant; no membership was installed.')
    if grant['target']!=service.host or grant['host']==service.host:
        raise HandoffError('Grant belongs to another deployment.')
    key=grant['host']+'/'+grant['id'];confirmation=receipt(grant)
    with service.store.transaction():
        installed=service.store.get('migration-member',key)
        if installed:
            if installed!=confirmation:
                raise HandoffError('Another local handoff already owns this board.')
            # A later decline/leave/revocation wins over a repeated installer.
            # Keep the receipt independently of the mutable membership.
            return confirmation
        if service.store.get('joined',key):
            raise HandoffError('Another local membership already owns this board.')
        handoff={'from':'common/0','transition':grant['transition'],'digest':grant['digest']}
        member={k:grant[k] for k in ('id','host','member_id','credential','role','label')}
        member.update(status='invited' if grant['pending'] else 'joined',transport=PROTOCOL,
                      handoff=handoff)
        service.store.put('joined',key,member)
        service.store.put('migration-member',key,confirmation)
        if grant['pending']:
            if service.store.get('invitation',key):
                raise HandoffError('Existing invitation needs explicit reconciliation.')
            service.store.put('invitation',key,{'id':grant['id'],'host':grant['host'],'label':grant['label'],
                'invite':grant['id']+'@'+grant['host']+'#'+grant['credential'],
                'role':grant['role'],'status':'pending','received_at':service.now(),'verified':True})
    return confirmation


def activate(service, authority, oid, confirmations):
    """Source frozen + every retained member installed, then one atomic enable."""
    with authority.lease(exclusive=True):
        archive=authority.verify(oid)
        current={**authority.snapshot(oid),'transition':archive['transition']}
        if fingerprint(current)!=fingerprint(archive):
            raise HandoffError('Frozen source changed; activation needs investigation.')
        with service.store.transaction():
            state=service.store.get('migration',oid)
            if not state or state['digest']!=fingerprint(archive):
                raise HandoffError('No matching staged board.')
            expected=state.get('receipts') or [receipt(g) for g in state.get('grants',[])]
            if sorted(map(canonical,confirmations))!=sorted(map(canonical,expected)):
                raise HandoffError('Every retained deployment must confirm its exact grant install.')
            if state['phase']=='active': return {'status':'active','id':oid,'digest':state['digest']}
            row=service.store.get('board',oid)
            if not row or not row.get('staged'):
                raise HandoffError('The prepared authority changed.')
            row.pop('staged');service.store.put('board',oid,row)
            state.update(phase='active',receipts=expected);state.pop('grants',None)
            service.store.put('migration',oid,state)
            return {'status':'active','id':oid,'digest':state['digest']}
