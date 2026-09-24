import assert from 'node:assert/strict'
import test from 'node:test'

import { listBoardsWithStatus } from '../storage.js'

test('status-aware board listing preserves completeness and normalizes bodies', async (t) => {
  const previousWindow = globalThis.window
  t.after(() => { globalThis.window = previousWindow })
  globalThis.window = {
    mobius: {
      online: false,
      storage: {
        async listWithStatus() {
          return {
            complete: false,
            source: 'cache',
            entries: [{
              type: 'file', name: 'a.json', path: 'boards/a.json',
              content: { v: 1, id: 'a', title: 'Cached', columns: [], cards: {} },
            }],
          }
        },
      },
    },
  }

  assert.deepEqual(await listBoardsWithStatus(), {
    complete: false,
    source: 'cache',
    boards: [{
      id: 'a', title: 'Cached', cardCount: 0, columnCount: 0,
      columnPreview: [], createdAt: '',
    }],
  })
})

test('legacy board listing is authoritative only when reachable', async (t) => {
  const previousWindow = globalThis.window
  t.after(() => { globalThis.window = previousWindow })
  globalThis.window = {
    mobius: {
      online: true,
      storage: { async list() { return [] } },
    },
  }
  assert.deepEqual(await listBoardsWithStatus(), {
    boards: [], complete: true, source: 'legacy-server',
  })
  globalThis.window.mobius.online = false
  assert.deepEqual(await listBoardsWithStatus(), {
    boards: [], complete: false, source: 'legacy-cache',
  })
})
