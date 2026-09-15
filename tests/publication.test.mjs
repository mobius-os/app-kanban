import test from 'node:test'
import assert from 'node:assert/strict'
import { configureSync, shareBoard, recoverMemberships, selfCollaborator, groupCollaborators } from '../sync.js'
import { PUBLICATION, fencePublication, sharingFromBoards } from '../publication.js'
import { createBoardRepository, isDiscardableBoardError } from '../boardRepository.js'
const doc=()=>({v:1,title:'Fixture',columns:[],cards:{}})
const pointer={oid:'a'.repeat(32),host:'me.example',role:'editor',transport:'kanban/1',publishing:true,hosted:true}
function fixture() {
  const files={'boards/b.json':doc()}; const writes=[]
  const storage={
    get:async path=>structuredClone(files[path]??null),
    getWithVersion:async path=>({value:structuredClone(files[path]??null),version:files[path]?'v1':null}),
    durableWrite:async(path,value)=>{writes.push(path); files[path]=structuredClone(value)},
    set:async()=>assert.fail('must not write a cache'),
  }
  globalThis.window={mobius:{storage}}
  return {files,writes,storage}
}
test.beforeEach(()=>configureSync('fixture',7))
test.afterEach(()=>{delete globalThis.window;delete globalThis.fetch})

test('failed discovery save retains a fenced record and sends no publication',async()=>{
  const f=fixture();let posts=0
  f.storage.durableWrite=async(path,value)=>{
    if(path==='shared.json')throw new Error('Map unavailable')
    f.files[path]=structuredClone(value)
  }
  globalThis.fetch=async(url,options)=>{
    if(options.method==='POST')posts++
    return Response.json({protocol:'kanban/1',host:'me.example'})
  }
  await assert.rejects(shareBoard('b'),/Map unavailable/)
  assert.ok(f.files['boards/b.json'][PUBLICATION])
  assert.equal(posts,0)
  const repo=createBoardRepository({storage:f.storage,request:async()=>Response.json({protocol:'kanban/1',code:'board-missing',detail:'Pending creation'},{status:404})})
  const error=await repo.mutate('b',{type:'rename-board',title:'Retain'}).catch(e=>e)
  assert.equal(error.code,'publication-pending');assert.equal(isDiscardableBoardError(error),false)
})

test('a private edit already in flight cannot overwrite the publication fence on CAS retry',async()=>{
  const f=fixture();let reads=0
  f.storage.getWithVersion=async path=>{
    if(path==='shared.json')return {value:{byBoard:{}},version:'map'}
    reads++
    return {value:reads>=2?{...doc(),[PUBLICATION]:pointer}:doc(),version:'v'+reads}
  }
  const error=await createBoardRepository({storage:f.storage}).mutate('b',{type:'rename-board',title:'Must not overwrite'}).catch(e=>e)
  assert.equal(error.code,'publication-pending'); assert.deepEqual(f.writes,[])
})

test('publication retry uses the same authority and the fenced snapshot',async()=>{
  const f=fixture();await fencePublication(f.storage,'b',pointer)
  const ids=[]
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/health'))return Response.json({protocol:'kanban/1',host:'me.example'})
    const body=JSON.parse(options.body);ids.push(body.id)
    if(ids.length===1)throw new Error('Lost reply')
    return Response.json({id:body.id,host:'me.example',version:4})
  }
  await assert.rejects(shareBoard('b'),/Lost reply/)
  const entry=await shareBoard('b')
  assert.deepEqual(ids,[pointer.oid,pointer.oid]);assert.equal(entry.version,4);assert.equal(entry.publishing,undefined)
})

test('completed join is rediscovered without overwriting another or legacy authority',async()=>{
  const f=fixture();f.files['shared.json']={byBoard:{keep:{oid:'old',host:'legacy.example',role:'editor'}}}
  const calls=[]
  const request=async(url)=>{calls.push(url);return Response.json(url.endsWith('/resume-joins')?{results:[]}:{hosted:[],joined:[
    {id:'joined',host:'peer.example',role:'viewer',transport:'kanban/1',label:'Joined'},
    {id:'keep',host:'new.example',role:'editor',transport:'kanban/1'},
  ]})}
  await recoverMemberships(f.storage,request)
  assert.equal(f.files['shared.json'].byBoard.joined.role,'viewer')
  assert.equal(f.files['shared.json'].byBoard.keep.host,'legacy.example')
  assert.equal(calls.length,2)
})

test('discovery renders a fenced publication even when the share index save failed',()=>{
  const map=sharingFromBoards([{id:'b',publication:pointer}],{byBoard:{}})
  assert.deepEqual(map.byBoard.b,pointer)
})


test('self identity uses the admitted member id, never a claimed host or active-peer guess',()=>{
  const groups=groupCollaborators([
    {member_id:'owner',host:'host.example',host_owner:true},
    {member_id:'imposter',host:'host.example',active:true},
    {member_id:'mine',host:'me.example',collaborator_id:'group'},
    {member_id:'also-mine',host:'other.example',collaborator_id:'group'},
  ])
  assert.equal(selfCollaborator(groups,{hosted:true}).member_id,'owner')
  assert.equal(selfCollaborator(groups,{host:'host.example',member_id:'also-mine'}).member_id,'mine')
  assert.equal(selfCollaborator(groups,{host:'host.example'}),null)
})

test('verified administrative handoff adopts only matching legacy pointers and preserves local queue identity',async()=>{
  const f=fixture()
  f.files['shared.json']={byBoard:{localAlias:{oid:'remote',host:'peer.example',role:'editor'},other:{oid:'remote',host:'different.example'}}}
  f.files['pending-ops.json']={sentinel:'untouched'}
  const request=async url=>Response.json(url.endsWith('/resume-joins')?{results:[]}:{hosted:[],joined:[{
    id:'remote',host:'peer.example',role:'viewer',member_id:'mine',transport:'kanban/1',
    handoff:{from:'common/0',transition:'a'.repeat(32),digest:'b'.repeat(64)},
  }]})
  await recoverMemberships(f.storage,request)
  assert.equal(f.files['shared.json'].byBoard.localAlias.member_id,'mine')
  assert.equal(f.files['shared.json'].byBoard.localAlias.role,'viewer')
  assert.equal(f.files['shared.json'].byBoard.other.host,'different.example')
  assert.equal(f.files['shared.json'].byBoard.remote,undefined)
  assert.deepEqual(f.files['pending-ops.json'],{sentinel:'untouched'})
  assert.deepEqual(f.writes,['shared.json'])
})
