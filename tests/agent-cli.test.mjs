import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

test('CLI writes private and shared boards through their authority using JSON and stable retries', async () => {
  const makeBoard = () => ({ v: 1, title: 'Fixture', columns: [
    { id: 'todo', name: 'To do', cardIds: [] }, { id: 'done', name: 'Done', cardIds: [] },
  ], cards: {} })
  let local = makeBoard(), remote = makeBoard(), version = 1, shared = true
  let cacheWrites = 0, sharedWrites = 0
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== 'Bearer fixture') { res.writeHead(401); res.end('{}'); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const send = value => res.end(JSON.stringify(value))
    if (req.method === 'PUT' && req.headers['content-type'] !== 'application/json') {
      res.writeHead(415); send({ detail: 'JSON required' }); return
    }
    if (req.url === '/api/apps/') return send([{ id: 1, slug: 'kanban' }])
    if (req.url === '/api/storage/apps/1/shared.json') {
      res.setHeader('ETag', '"map"')
      return send({ byBoard: shared ? { b: { oid: 'obj', host: 'peer.example', role: 'editor' } } : {} })
    }
    if (req.url === '/api/storage/apps/1/boards/b.json') {
      if (req.method === 'PUT') { cacheWrites++; local = JSON.parse(body); res.writeHead(204); res.end(); return }
      res.setHeader('ETag', '"local"')
      return send(local)
    }
    if (req.url.startsWith('/api/common/objects/peer.example/obj/state')) {
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
  const run = (command, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/kanban.mjs', command, 'b'], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, API_BASE_URL: `http://127.0.0.1:${server.address().port}`, AGENT_TOKEN: 'fixture' },
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
    shared = false; local = makeBoard(); cacheWrites = 0
    assert.equal((await run('add-card', input)).authority, 'private')
    assert.equal(cacheWrites, 1)
    assert.equal(sharedWrites, 4)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
