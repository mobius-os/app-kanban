import test from 'node:test'
import assert from 'node:assert/strict'
import { configureSync, pullShared, leaveBoard, deleteSharedObject } from '../sync.js'
import { createBoardRepository, isDiscardableBoardError } from '../boardRepository.js'
const entry = { oid:'a'.repeat(32), host:'peer.example', role:'editor', transport:'kanban/1' }
const doc = {v:1,title:'Fixture',columns:[],cards:{}}
function storage(pointer=entry) { return {
  getWithVersion:async()=>({value:{byBoard:{b:pointer}},version:'map'}),
  set:async()=>{ throw new Error('Must not write an unconfirmed cache') },
} }
test.beforeEach(()=>configureSync('fixture',7))
test.afterEach(()=>{delete globalThis.window;delete globalThis.fetch})

test('legacy authority is never silently retagged or its pending edit discarded',async()=>{
  const legacy={...entry}; delete legacy.transport
  let called=false
  const repo=createBoardRepository({storage:storage(legacy),request:async()=>{called=true;throw new Error('must not call')}})
  const error=await repo.mutate('b',{type:'rename-board',title:'Retain intent'}).catch(e=>e)
  assert.equal(error.code,'migration-required')
  assert.equal(isDiscardableBoardError(error),false)
  assert.equal(called,false)
})

test('same-app numeric service identity replaces a dependency on another app name',async()=>{
  await pullShared(entry,-1,async(url)=>{
    assert.equal(url,`/api/apps/7/service/boards/peer.example/${entry.oid}/state?since_version=-1`)
    return Response.json({protocol:'kanban/1',version:1,doc})
  })
  assert.throws(()=>configureSync('fixture','7'),/identity/)
})

for(const status of [403,404]) test(`gateway ${status} retains pending operations and sharing pointers`,async()=>{
  const request=async()=>Response.json({detail:'App service unavailable'},{status})
  const error=await createBoardRepository({storage:storage(),request}).mutate('b',{type:'rename-board',title:'Keep'}).catch(e=>e)
  assert.equal(error.code,'service-unavailable')
  assert.equal(isDiscardableBoardError(error),false)
  globalThis.fetch=request
  let wrote=false
  globalThis.window={mobius:{storage:{...storage(),durableWrite:async()=>{wrote=true}}}}
  await assert.rejects(leaveBoard('b',entry))
  await assert.rejects(deleteSharedObject(entry.oid))
  assert.equal(wrote,false)
})

test('a domain-confirmed deletion remains terminal without weakening revocation',async()=>{
  for(const [status,code] of [[404,'board-missing'],[403,'membership-revoked'],[403,'read-only']]) {
    const error=await createBoardRepository({storage:storage(),request:async()=>Response.json({protocol:'kanban/1',code,detail:'Confirmed by authority'},{status})}).mutate('b',{type:'rename-board',title:'No'}).catch(e=>e)
    assert.equal(isDiscardableBoardError(error),true)
  }
})
