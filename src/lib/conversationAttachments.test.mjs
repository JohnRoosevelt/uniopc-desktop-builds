import test from 'node:test'
import assert from 'node:assert/strict'
import {
  conversationAttachmentTypeLabel,
  conversationImageAttachmentToGateway,
  conversationImageAttachmentsToGateway,
  gatewayHistoryMediaToAttachments,
  nativeDragPositionToViewport,
  validateConversationImageAttachment,
  validateConversationImageAttachments,
} from './conversationAttachments.js'

test('attachment cards label legacy and OpenXML PowerPoint MIME types as PPT', () => {
  assert.equal(conversationAttachmentTypeLabel('application/vnd.ms-powerpoint'), 'PPT')
  assert.equal(conversationAttachmentTypeLabel('application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'PPT')
})

test('native macOS Finder drop points retain webview-local point coordinates', () => {
  assert.deepEqual(nativeDragPositionToViewport({ x: 1200, y: 810 }, {
    eventType: 'drop',
    platform: 'macos',
    scaleFactor: 2,
    viewportHeight: 892,
  }), { x: 1200, y: 810 })
})

test('native macOS drag-over points retain webview top-left coordinates', () => {
  assert.deepEqual(nativeDragPositionToViewport({ x: 1200, y: 810 }, {
    eventType: 'over',
    platform: 'macos',
    scaleFactor: 2,
    viewportHeight: 892,
  }), { x: 1200, y: 810 })
})

test('native drag points from other platforms convert physical pixels using scale factor', () => {
  assert.deepEqual(nativeDragPositionToViewport({ x: 2400, y: 1620 }, {
    eventType: 'drop',
    platform: 'other',
    scaleFactor: 2,
    viewportHeight: 892,
  }), { x: 1200, y: 810 })
})

test('conversation image attachments convert data URLs to Uniopc 引擎 gateway payloads', () => {
  const attachment = {
    id: 'img-1',
    name: 'screen.png',
    mimeType: 'image/png',
    size: 12,
    dataUrl: 'data:image/png;base64,aGVsbG8=',
  }

  assert.deepEqual(conversationImageAttachmentToGateway(attachment), {
    type: 'image',
    mimeType: 'image/png',
    fileName: 'screen.png',
    content: 'aGVsbG8=',
  })
})

test('conversation PDF attachments convert data URLs to Uniopc 引擎 gateway payloads', () => {
  const attachment = {
    id: 'pdf-1',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: 4,
    dataUrl: 'data:application/pdf;base64,JVBERg==',
  }

  assert.deepEqual(conversationImageAttachmentToGateway(attachment), {
    type: 'file',
    mimeType: 'application/pdf',
    fileName: 'report.pdf',
    content: 'JVBERg==',
  })
})

test('conversation image attachment validation rejects non-image data URLs', () => {
  assert.throws(
    () => validateConversationImageAttachment({
      id: 'doc-1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 12,
      dataUrl: 'data:text/plain;base64,aGVsbG8=',
    }),
    /图片数据格式无效/,
  )
})

test('conversation image attachment validation enforces per-image size limit', () => {
  assert.throws(
    () => validateConversationImageAttachment({
      id: 'large-img',
      name: 'large.png',
      mimeType: 'image/png',
      size: 10 * 1024 * 1024 + 1,
      dataUrl: 'data:image/png;base64,aGVsbG8=',
    }),
    /超过 10 MiB 限制/,
  )
})

test('all supported attachment types retain the 10 MiB per-file limit', () => {
  for (const mimeType of [
    'image/png',
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'video/mp4',
  ]) {
    assert.throws(
      () => validateConversationImageAttachment({
        id: `large-${mimeType}`,
        name: 'large-attachment',
        mimeType,
        size: 10 * 1024 * 1024 + 1,
        localMediaId: '0e3c9371-5c9e-4db3-9e74-79ac36b3b134',
        path: '/managed/media/inbound/id',
      }),
      /超过 10 MiB 限制/,
    )
  }
})

test('conversation attachments retain the four-file count limit', () => {
  const attachments = Array.from({ length: 5 }, (_, index) => ({
    id: `local-${index}`,
    name: `file-${index}.txt`,
    mimeType: 'text/plain',
    size: 1,
    localMediaId: '0e3c9371-5c9e-4db3-9e74-79ac36b3b134',
    path: `/managed/media/inbound/${index}`,
  }))

  assert.throws(
    () => validateConversationImageAttachments(attachments),
    /一次最多发送 4 个附件/,
  )
})

test('gateway history media paths become renderable image attachments', () => {
  const attachments = gatewayHistoryMediaToAttachments(
    ['/state/p/media/inbound/a.png', '/state/p/media/inbound/b.jpg'],
    ['image/png', 'image/jpeg'],
    path => `asset://localhost/${path}`,
  )
  assert.equal(attachments.length, 2)
  assert.equal(attachments[0].path, '/state/p/media/inbound/a.png')
  assert.equal(attachments[0].dataUrl, 'asset://localhost//state/p/media/inbound/a.png')
  assert.equal(attachments[0].name, 'a.png')
  assert.equal(attachments[1].mimeType, 'image/jpeg')
})

test('gateway history media preserves video and document attachments for their matching renderers', () => {
  const attachments = gatewayHistoryMediaToAttachments(
    ['/state/p/media/inbound/a.png', '/state/p/media/inbound/clip.mp4'],
    ['image/png', 'video/mp4'],
    path => path,
  )
  assert.deepEqual(attachments.map(item => item.path), ['/state/p/media/inbound/a.png', '/state/p/media/inbound/clip.mp4'])
  assert.equal(attachments[1].name, 'clip.mp4')
})

test('managed local attachment refs send opaque IDs without file bytes', () => {
  const attachments = conversationImageAttachmentsToGateway([{
    id: 'local-1',
    localMediaId: '0e3c9371-5c9e-4db3-9e74-79ac36b3b134',
    name: 'deck.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 1024,
    path: '/managed/media/inbound/id',
  }])
  assert.deepEqual(attachments, [{
    type: 'file',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    fileName: 'deck.pptx',
    localMediaId: '0e3c9371-5c9e-4db3-9e74-79ac36b3b134',
    sizeBytes: 1024,
  }])
  assert.equal('content' in attachments[0], false)
})

test('gateway history media tolerates a missing mime type', () => {
  const [attachment] = gatewayHistoryMediaToAttachments(['/state/p/media/inbound/a.png'], [], path => path)
  assert.equal(attachment.mimeType, 'image/png')
})
