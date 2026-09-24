import test from 'node:test'
import assert from 'node:assert/strict'

import { createLatestRequestGuard } from '../request-guard.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((next, fail) => { resolve = next; reject = fail })
  return { promise, resolve, reject }
}

test('a reconnect refresh wins when startup resolves afterwards', async () => {
  const guard = createLatestRequestGuard()
  const startup = deferred()
  const reconnect = deferred()
  const visible = []
  const apply = async (pending) => {
    const isCurrent = guard.begin()
    const result = await pending.promise
    if (isCurrent()) visible.push(result)
  }

  const startupRun = apply(startup)
  const reconnectRun = apply(reconnect)
  reconnect.resolve('fresh boards')
  startup.resolve('stale startup boards')
  await Promise.all([startupRun, reconnectRun])

  assert.deepEqual(visible, ['fresh boards'])
})

test('a late startup failure cannot replace a successful reconnect refresh', async () => {
  const guard = createLatestRequestGuard()
  const startup = deferred()
  const reconnect = deferred()
  const visible = []
  const run = async (pending) => {
    const isCurrent = guard.begin()
    try {
      const result = await pending.promise
      if (isCurrent()) visible.push(result)
    } catch (error) {
      if (isCurrent()) visible.push(`error: ${error.message}`)
    }
  }

  const startupRun = run(startup)
  const reconnectRun = run(reconnect)
  reconnect.resolve('fresh boards')
  startup.reject(new Error('stale startup failure'))
  await Promise.all([startupRun, reconnectRun])

  assert.deepEqual(visible, ['fresh boards'])
})
