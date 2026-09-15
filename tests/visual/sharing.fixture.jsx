import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ShareSheet} from './ui/Board.jsx'
import {configureSync} from './sync.js'
import {CSS} from './theme.js'
const entry={oid:'a'.repeat(32),host:'fixture.example',hosted:true,role:'editor',publishing:true,transport:'kanban/1'}
const files={'boards/fixture.json':{v:1,title:'Disposable fixture',columns:[],cards:{},_kanbanPublication:entry},'shared.json':{byBoard:{fixture:entry}}}
window.__fixture={posts:0,copied:null}
window.mobius={storage:{
 get:async p=>structuredClone(files[p]??null),
 getWithVersion:async p=>({value:structuredClone(files[p]??null),version:'fixture-version'}),
 durableWrite:async(p,v)=>{files[p]=structuredClone(v)},
 subscribe:()=>()=>{},
},clipboard:{writeText:async text=>{window.__fixture.copied=text;return true}},signal:()=>{}}
window.fetch=async(url,opts={})=>{
 if(!String(url).startsWith('/api/apps/7/service/')) return Response.json({detail:'Blocked unrelated fixture request'},{status:503})
 if(String(url).endsWith('/health'))return Response.json({protocol:'kanban/1',host:entry.host})
 if(String(url).endsWith('/invites'))return Response.json({protocol:'kanban/1',invite:'disposable-fixture-invitation'})
 if(opts.method==='POST'){window.__fixture.posts++;return Response.json({protocol:'kanban/1',id:entry.oid,host:entry.host,version:1})}
 return Response.json({protocol:'kanban/1',members:{}})
}
configureSync('disposable-fixture',7)
function Fixture(){
 const [share,setShare]=useState(entry)
 return <div className="kb-root"><style>{CSS}</style><ShareSheet boardId="fixture" share={share} members={[]} onMembersChange={()=>{}} onShared={setShare} onClose={()=>{}} /></div>
}
document.body.replaceChildren()
const container=document.createElement('div');document.body.append(container)
createRoot(container).render(<Fixture />)
export default Fixture
