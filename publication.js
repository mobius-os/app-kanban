// Publishing is a change of authority, not a cache write. Fence the private
// document with CAS before contacting the shared host. An in-flight private
// writer must observe the fence when its stale CAS retries.
import { boardPath, normalizeBoard } from './storage.js'
export const PUBLICATION = '_kanbanPublication'
export function publicationPending() {
  return Object.assign(new Error('Sharing is being finished. Your edit is retained; finish sharing and retry.'), { code:'publication-pending', retryable:true, discardable:false })
}
export async function fencePublication(storage, boardId, proposed) {
  for(let attempt=0;attempt<6;attempt++) {
    const {value,version}=await storage.getWithVersion(boardPath(boardId))
    const doc=normalizeBoard(structuredClone(value))
    if(!doc || !version) throw new Error('A confirmed private board is required before sharing.')
    const entry=doc[PUBLICATION] || proposed
    if(doc[PUBLICATION]) return {entry,doc}
    doc[PUBLICATION]=entry
    try {
      const result=await storage.durableWrite(boardPath(boardId),doc,{ifMatch:version})
      if(result==='queued' || result?.queued || result?.status==='queued') throw new Error('Publication needs a confirmed connection.')
      return {entry,doc}
    } catch(error) { if(error.code!=='conflict') throw error }
  }
  throw new Error('The private board is changing too quickly to start sharing.')
}
export function sharingFromBoards(boards,map) {
  const byBoard={...map.byBoard}
  for(const board of boards) if(board.publication && !byBoard[board.id]) byBoard[board.id]=board.publication
  return {...map,byBoard}
}
