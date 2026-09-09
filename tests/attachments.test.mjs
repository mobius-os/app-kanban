import test from 'node:test'
import assert from 'node:assert/strict'

import {
  consumeAttachmentPaste,
  filesFromClipboard,
  isPreviewImage,
  normalizeAttachmentMime,
  prepareAttachment,
} from '../attachments.js'

test('text paste is left untouched while clipboard files are consumed', () => {
  let prevented = false
  const textEvent = {
    clipboardData: { files: [], items: [{ kind: 'string' }] },
    preventDefault() { prevented = true },
  }
  assert.deepEqual(consumeAttachmentPaste(textEvent, true), [])
  assert.equal(prevented, false)

  const file = { name: 'brief.pdf', size: 12, type: 'application/pdf' }
  const fileEvent = {
    clipboardData: { files: [file] },
    preventDefault() { prevented = true },
  }
  assert.deepEqual(consumeAttachmentPaste(fileEvent, true), [file])
  assert.equal(prevented, true)
})

test('read-only cards never consume file paste', () => {
  let prevented = false
  const event = {
    clipboardData: { files: [{ name: 'brief.pdf' }] },
    preventDefault() { prevented = true },
  }
  assert.deepEqual(consumeAttachmentPaste(event, false), [])
  assert.equal(prevented, false)
})

test('clipboard item fallback extracts only files', () => {
  const file = { name: 'pasted.png', size: 4, type: 'image/png' }
  const clipboardData = {
    files: [],
    items: [
      { kind: 'string' },
      { kind: 'file', getAsFile: () => file },
      { kind: 'file', getAsFile: () => null },
    ],
  }
  assert.deepEqual(filesFromClipboard(clipboardData), [file])
})

test('unknown or missing MIME types use the safe generic download type', () => {
  assert.equal(normalizeAttachmentMime({ type: '' }), 'application/octet-stream')
  assert.equal(normalizeAttachmentMime({ type: 'application/x-custom' }), 'application/octet-stream')
  assert.equal(normalizeAttachmentMime({ type: ' Application/PDF ' }), 'application/pdf')
  assert.equal(isPreviewImage({ mime: 'image/png' }), true)
  assert.equal(isPreviewImage({ mime: 'image/svg+xml' }), false)
})

test('ordinary files retain their bytes and reject the per-file limit', async () => {
  const file = new Blob(['hello'], { type: 'text/plain' })
  const prepared = await prepareAttachment(file)
  assert.equal(prepared.blob, file)
  assert.equal(prepared.mime, 'text/plain')

  const unknown = await prepareAttachment(new Blob(['opaque'], { type: 'application/x-custom' }))
  assert.equal(unknown.mime, 'application/octet-stream')
  assert.equal(unknown.blob.type, 'application/octet-stream')

  await assert.rejects(
    prepareAttachment({ size: 5 * 1024 * 1024 + 1, type: 'application/pdf' }),
    /larger than 5 MB/,
  )
})
