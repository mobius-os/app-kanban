import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

test('CLI writes private and shared boards through their authority using JSON and stable retries', async () => {
  const makeBoard = () => ({ v: 1, title: 'Fixture', columns: [
    { id: 'todo', name: 'To do', cardIds: [] }, { id: 'done', name: 'Done', cardIds: [] },
  ], cards: {} })
  let local = makeBoard(), remote = makeBoard(), version = 1, shared = true
  let cacheWrites = 0, sharedWrites = 0, serviceUnavailable = false, hiddenUnavailable = false
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== 'Bearer fixture') { res.writeHead(401); res.end('{}'); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const send = value => res.end(JSON.stringify(value))
    if (req.method === 'PUT' && req.headers['content-type'] !== 'application/json') {
      res.writeHead(415); send({ detail: 'JSON required' }); return
    }
    if (serviceUnavailable && req.url.startsWith('/api/apps/1/service/')) {
      res.writeHead(503); return send({detail:'Service unavailable'})
    }
    if (req.url === '/api/apps/1/service/boards/resume-joins') return send({results:[]})
    if (req.url === '/api/apps/1/service/boards') return send({hosted:[],joined:[]})
    if (req.url === '/api/apps/') return send([{ id: 1, slug: 'kanban' }])
    if (req.url.startsWith('/api/storage/apps-list/1/boards/')) return send({entries:[{name:'b.json',path:'boards/b.json'}],next_cursor:null})
    if (req.url === '/api/storage/apps/1/shared.json') {
      res.setHeader('ETag', '"map"')
      return send({ byBoard: {
        ...(shared ? { b: { oid: 'obj', transport: 'kanban/1', host: 'peer.example', role: 'editor' } } : {}),
        ...(hiddenUnavailable ? { hidden: { oid: 'hidden', transport: 'kanban/1', host: 'offline.example', role: 'editor' } } : {}),
      } })
    }
    if (req.url === '/api/storage/apps/1/boards/b.json') {
      if (req.method === 'PUT') { cacheWrites++; local = JSON.parse(body); res.writeHead(204); res.end(); return }
      res.setHeader('ETag', '"local"')
      return send(local)
    }
    if (req.url.startsWith('/api/apps/1/service/boards/peer.example/obj/state')) {
      if (req.method === 'PUT') {
        const data = JSON.parse(body)
        if (data.expected_version !== version) return send({ status: 'conflict' })
        remote = data.doc; sharedWrites++; version++
        return send({ status: 'ok', version })
      }
      return send({ doc: remote, version })
    }
    res.writeHead(404); send({})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const run = (command, input, boardId = 'b') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/kanban.mjs', command, boardId], {
      cwd: new URL('../', import.meta.url),
      env: { PATH: process.env.PATH, API_BASE_URL: `http://127.0.0.1:${server.address().port}`, AGENT_TOKEN: 'fixture' },
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)))
    child.stdin.end(JSON.stringify(input))
  })
  try {
    const input = { id: 'stable', columnId: 'todo', title: 'Fixture card' }
    assert.equal((await run('add-card', input)).authority, 'shared')
    await run('add-card', input)
    assert.deepEqual(remote.columns[0].cardIds, ['stable'])
    await run('update-card', { cardId: 'stable', patch: { notes: 'Edited' } })
    assert.equal(remote.cards.stable.notes, 'Edited')
    // Input cannot turn a move into an unrelated operation.
    await run('move-card', { type: 'delete-card', cardId: 'stable', toColumnId: 'done' })
    assert.ok(remote.cards.stable)
    assert.deepEqual(remote.columns[1].cardIds, ['stable'])
    assert.equal(sharedWrites, 4)
    await assert.rejects(run('update-card', { cardId: 'stable', patch: { notes: { unsafe: true } } }), /notes must be a string/)
    await assert.rejects(run('add-card', { id: '__proto__', columnId: 'todo', title: 'Unsafe' }), /safe non-empty string/)
    await assert.rejects(run('read', undefined, '../../2/boards/private'), /Usage/)
    assert.equal(sharedWrites, 4)
    const priorCacheWrites = cacheWrites
    serviceUnavailable = true
    await assert.rejects(run('update-card', {cardId:'stable', patch:{notes:'Unconfirmed'}}), /Service unavailable/)
    assert.equal(cacheWrites, priorCacheWrites)
    shared = false; local = makeBoard(); cacheWrites = 0
    assert.equal((await run('add-card', input)).authority, 'private')
    assert.equal(cacheWrites, 1)
    assert.equal(sharedWrites, 4)

    const completion = { title: 'Fixture card', summary: 'Shipped the exact task', prUrl: 'https://github.com/mobius-os/app-kanban/pull/19' }
    assert.equal((await run('complete-matching-card', completion)).status, 'saved')
    assert.match(local.cards.stable.notes, /Shipped the exact task/)
    assert.deepEqual(local.columns[1].cardIds, ['stable'])

    // An idempotent retry still repairs the destination column without
    // duplicating the completion note.
    await run('move-card', { cardId: 'stable', toColumnId: 'todo' })
    assert.equal((await run('complete-matching-card', completion)).status, 'already-saved')
    assert.deepEqual(local.columns[1].cardIds, ['stable'])
    assert.equal(local.cards.stable.notes.match(/pull\/19/g).length, 1)
    await assert.rejects(run('complete-matching-card', { ...completion, title: 'Similar card' }), /No Kanban card exactly matches/)

    hiddenUnavailable = true
    const writesBeforePartialDiscovery = cacheWrites
    await assert.rejects(run('complete-matching-card', completion), /Cannot safely complete a card by title while 1 recorded board is unavailable/)
    assert.equal(cacheWrites, writesBeforePartialDiscovery)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
