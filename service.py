#!/usr/bin/env python3
"""JSON-v1 entry point. Runs only from explicitly supplied app context."""
import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import quote
import httpx
from collaboration.service import Service, Failure

async def dispatch(request):
    async def resolve(handle):
        async with httpx.AsyncClient(timeout=5,follow_redirects=False,trust_env=False) as client:
            response=await client.get(os.environ['API_BASE_URL'].rstrip('/')+'/api/identity/handles/'+quote(handle,safe=''),headers={'Authorization':'Bearer '+os.environ['APP_TOKEN']})
        if response.status_code!=200:
            raise Failure(503,'identity-unavailable','Collaborator identity could not be resolved.')
        data=response.json()
        return data.get('hosts') if data.get('linked') is True else None
    service=Service(Path(os.environ['APP_STORAGE_DIR'])/'server',host=os.environ['INSTANCE_DOMAIN'],app_id=int(os.environ['APP_ID']),resolve=resolve)
    try: return await service.handle(request)
    finally: service.close()

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
