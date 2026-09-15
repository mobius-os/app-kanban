"""Back up/freeze one legacy host, then import for ordinary re-invitations.

Administrative library only; explicit paths and owner approval are required.
No collaborator credentials are copied or minted, and no remote upgrade gate
exists. The immutable legacy archive retains former membership metadata.
"""
import base64
import hashlib
import re

from collaboration.service import ASSET, check, document
from .legacy_authority import HandoffError, fingerprint

EXT_MIME = dict(zip(
    'jpg png webp gif pdf txt md csv json zip doc xls ppt docx xlsx pptx bin'.split(),
    ['image/jpeg','image/png','image/webp','image/gif','application/pdf','text/plain',
     'text/markdown','text/csv','application/json','application/zip','application/msword',
     'application/vnd.ms-excel','application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'application/octet-stream']))


def stage(service, authority, oid, local_id):
    """Stage host data once; collaborators rejoin using ordinary invitations."""
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
                return {'id':oid,'digest':sha,'reinvite_count':previous['reinvite_count']}
            if service.store.get('board',oid):
                raise HandoffError('Refusing to replace an existing Kanban board.')
            member={k:v for k,v in owner.items() if k in ('name','handle','role','collaborator_id')}
            member.update(host=service.host,host_owner=True,pending=False,seen=0)
            members={service.host:member}
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
                 'members':members,'invites':{},'staged':True,
                 'handoff':{'from':'common/0','transition':archive['transition'],'digest':sha}}
            service.store.put('board',oid,row)
            service.store.put('migration',oid,{'phase':'staged','digest':sha,'local_id':local_id,'reinvite_count':len(old_members)-1})
            return {'id':oid,'digest':sha,'reinvite_count':len(old_members)-1}


def activate(service, authority, oid):
    """Enable the host only after its frozen archive still matches exactly."""
    with authority.lease(exclusive=True):
        archive=authority.verify(oid)
        current={**authority.snapshot(oid),'transition':archive['transition']}
        if fingerprint(current)!=fingerprint(archive):
            raise HandoffError('Frozen source changed; activation needs investigation.')
        with service.store.transaction():
            state=service.store.get('migration',oid)
            if not state or state['digest']!=fingerprint(archive):
                raise HandoffError('No matching staged board.')
            if state['phase']=='active': return {'status':'active','id':oid,'digest':state['digest']}
            row=service.store.get('board',oid)
            if not row or not row.get('staged'):
                raise HandoffError('The prepared authority changed.')
            row.pop('staged');service.store.put('board',oid,row)
            state['phase']='active'
            service.store.put('migration',oid,state)
            return {'status':'active','id':oid,'digest':state['digest']}
