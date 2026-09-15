import {createRoot} from 'react-dom/client'
import Board from './ui/Board.jsx'
import {configureSync} from './sync.js'
import {CSS} from './theme.js'
const entry={oid:'fixture',host:'fixture.example',role:'viewer',transport:'kanban/1'}
const doc={v:1,id:'fixture',title:'Recovery check',columns:[{id:'todo',name:'To do',cardIds:[]}],cards:{}}
const files={'boards/fixture.json':doc,'shared.json':{byBoard:{fixture:entry}},'recovered-board-ops/fixture/offline.json':{id:'offline',op:{type:'rename-board',title:'Unsent work'},code:'read-only',reason:'Read only'}}
window.__recoveryFixture={download:null,files}
window.mobius={storage:{
 get:async p=>structuredClone(files[p]??null),getWithVersion:async p=>({value:structuredClone(files[p]??null),version:'fixture'}),
 durableWrite:async(p,v)=>{files[p]=structuredClone(v)},set:async(p,v)=>{files[p]=structuredClone(v)},
 list:async prefix=>Object.entries(files).filter(([p])=>p.startsWith(prefix)).map(([path,content])=>({path,content:structuredClone(content)})),
 subscribe:()=>()=>{},remove:async p=>{delete files[p]},
},signal:()=>{}}
window.fetch=async()=>Response.json({status:'ok',doc,version:1,members:{},protocol:'kanban/1'})
HTMLAnchorElement.prototype.click=function(){window.__recoveryFixture.download=JSON.parse(decodeURIComponent(this.href.split(',').slice(1).join(',')))}
configureSync('disposable',7)
document.body.replaceChildren()
const container=document.createElement('div');document.body.append(container)
createRoot(container).render(<div className="kb-root"><style>{CSS}</style><Board boardId="fixture" boards={[doc]} shareMap={{byBoard:{fixture:entry}}} share={entry} online={true} onAllBoards={()=>{}} /></div>)
