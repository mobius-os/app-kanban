// Card-attachment preparation and storage; board JSON keeps only small metadata.

import { deleteSharedAsset, getSharedAsset, putSharedAsset } from './sync.js'

export const MAX_CARD_ATTACHMENTS = 8
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_EDGE = 1920
const FALLBACK_MIME = 'application/octet-stream'
const RESIZABLE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const PREVIEW_IMAGE_MIMES = new Set([...RESIZABLE_IMAGE_MIMES, 'image/gif'])
const ACCEPTED_ATTACHMENT_MIMES = new Set([
  ...PREVIEW_IMAGE_MIMES,
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  FALLBACK_MIME,
])

const extensionForMime = mime => ({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}[mime] || 'bin')

export const normalizeAttachmentMime = file => {
  const mime = typeof file?.type === 'string' ? file.type.trim().toLowerCase() : ''
  return ACCEPTED_ATTACHMENT_MIMES.has(mime) ? mime : FALLBACK_MIME
}

export const isPreviewImage = attachment => PREVIEW_IMAGE_MIMES.has(attachment?.mime)

export const attachmentPath = (boardId, id, mime) =>
  `attachments/${boardId}/${id}.${extensionForMime(mime)}`

export function filesFromClipboard(clipboardData) {
  const files = [...(clipboardData?.files || [])]
  if (files.length) return files
  return [...(clipboardData?.items || [])]
    .filter(item => item?.kind === 'file')
    .map(item => item.getAsFile?.())
    .filter(Boolean)
}

export function consumeAttachmentPaste(event, canWrite) {
  if (!canWrite) return []
  const files = filesFromClipboard(event?.clipboardData)
  if (!files.length) return []
  event.preventDefault?.()
  return files
}

function canvasBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality))
}

async function prepareResizableImage(file) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That image could not be opened.')
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  const blob = await canvasBlob(canvas, 'image/webp', 0.85)
  if (!blob) throw new Error('That image could not be prepared.')
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error('That image is too large even after resizing.')
  return { blob, mime: blob.type || 'image/webp', width, height }
}

export async function prepareAttachment(file) {
  if (!file || typeof file.size !== 'number') throw new Error('Choose a file to attach.')
  const mime = normalizeAttachmentMime(file)
  if (RESIZABLE_IMAGE_MIMES.has(mime)) return prepareResizableImage(file)
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('That file is larger than 5 MB.')
  const blob = file.type === mime ? file : new Blob([file], { type: mime })
  return { blob, mime }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The attachment could not be read.'))
    reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || '')
    reader.readAsDataURL(blob)
  })
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The attachment could not be opened.'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(blob)
  })
}

export async function saveCardAttachment({ boardId, share, id, file }) {
  const { blob, mime, width, height } = await prepareAttachment(file)
  const path = attachmentPath(boardId, id, mime)
  if (share) await putSharedAsset(share, id, mime, await blobToBase64(blob))
  else await window.mobius.storage.setBlob(path, blob)
  return {
    id,
    name: String(file.name || (isPreviewImage({ mime }) ? 'Pasted image' : 'Pasted file')).slice(0, 180),
    mime,
    size: blob.size,
    ...(width && height ? { width, height } : {}),
    ...(share ? {} : { path }),
  }
}

export async function loadCardAttachment({ share, attachment }) {
  if (share) {
    const asset = await getSharedAsset(share, attachment.id)
    return `data:${asset.mime};base64,${asset.data}`
  }
  const blob = await window.mobius.storage.getBlob(attachment.path)
  if (!blob) throw new Error('Attachment not found.')
  return blobToDataUrl(blob)
}

export async function deleteCardAttachment({ share, attachment }) {
  if (share) return deleteSharedAsset(share, attachment.id)
  if (attachment.path) await window.mobius.storage.remove(attachment.path)
  return { status: 'deleted' }
}
