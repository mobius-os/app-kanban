#!/usr/bin/env python3
"""JSON-v1 entry point. Runs only from explicitly supplied app context."""
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import quote
import httpx
from collaboration.service import Service, Failure

OWNER_LABEL_TTL_S = 300


async def owner_label():
    """The owner's profile label, remembered for OWNER_LABEL_TTL_S.

    Every board read and write records it, so asking the identity service on
    each request added a platform round trip to every poll. A renamed profile
    shows within the TTL, and while the identity service is unreachable the
    last known label is kept; collaboration falls back to the deployment host
    only when no label was ever resolved.
    """
    path = Path(os.environ['APP_STORAGE_DIR']) / 'server' / 'owner-label.json'
    try:
        saved = json.loads(path.read_text())
    except (OSError, ValueError):
        saved = {}
    label = saved.get('label') if isinstance(saved.get('label'), str) else ''
    checked_at = saved.get('checked_at')
    if isinstance(checked_at, (int, float)) and time.time() - checked_at < OWNER_LABEL_TTL_S:
        return label
    try:
        # The app token has the reviewed identity capability.
        async with httpx.AsyncClient(timeout=5, follow_redirects=False, trust_env=False) as client:
            response = await client.get(
                os.environ['API_BASE_URL'].rstrip('/') + '/api/identity',
                headers={'Authorization': 'Bearer ' + os.environ['APP_TOKEN']},
            )
        if response.status_code != 200:
            return label
        profile = response.json().get('profile') or {}
    except Exception:
        return label
    handle = str(profile.get('handle') or '').strip().lstrip('@')
    display_name = str(profile.get('display_name') or '').strip()
    label = ('@' + handle) if handle else display_name
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        staged = path.with_name(f'.{path.name}.{os.getpid()}')
        staged.write_text(json.dumps({'label': label, 'checked_at': time.time()}))
        staged.replace(path)
    except OSError:
        pass
    return label


async def dispatch(request):
    path = str(request.get('path', '')).strip('/')
    owner_name = '' if path.startswith('peer/') else await owner_label()

    async def resolve(handle):
        async with httpx.AsyncClient(timeout=5,follow_redirects=False,trust_env=False) as client:
            response=await client.get(os.environ['API_BASE_URL'].rstrip('/')+'/api/identity/handles/'+quote(handle,safe=''),headers={'Authorization':'Bearer '+os.environ['APP_TOKEN']})
        if response.status_code!=200:
            raise Failure(503,'identity-unavailable','Collaborator identity could not be resolved.')
        data=response.json()
        return data.get('hosts') if data.get('linked') is True else None
    async def notify(payload):
        # A mention for this owner: the app token may notify its own owner, and
        # the platform attributes it to Kanban (bell entry plus push).
        async with httpx.AsyncClient(timeout=5,follow_redirects=False,trust_env=False) as client:
            await client.post(os.environ['API_BASE_URL'].rstrip('/')+'/api/notifications/send',json=payload,headers={'Authorization':'Bearer '+os.environ['APP_TOKEN']})
    service=Service(Path(os.environ['APP_STORAGE_DIR'])/'server',host=os.environ['INSTANCE_DOMAIN'],app_id=int(os.environ['APP_ID']),resolve=resolve,owner_name=owner_name,notify=notify)
    try: return await service.handle(request)
    finally: service.close()

# Möbius may run everything above once and fork each request from it,
# removing interpreter start-up and imports from every request. Module setup
# therefore reads only per-installation values and starts no threads.
MOBIUS_PRELOAD = True

if __name__=='__main__':
    try:
        raw=sys.stdin.buffer.read(8*1024*1024+1)
        if len(raw)>8*1024*1024: raise ValueError('Request too large')
        request=json.loads(raw,parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-finite JSON')))
        print(json.dumps(asyncio.run(dispatch(request)),separators=(',',':'),allow_nan=False))
    except Exception as exc:
        print('Kanban dispatch failed: '+type(exc).__name__,file=sys.stderr)
        # Never serialize the request, peer credentials or local environment.
        print(json.dumps({'status':500,'body':{'protocol':'kanban/1','code':'service-unavailable','detail':'Kanban could not complete the request. Pending edits are retained.'}}))
        raise SystemExit(0)
