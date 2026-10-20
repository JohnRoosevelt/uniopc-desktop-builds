import { createServer } from 'node:http'

const port = Number.parseInt(process.env.UNIOPC_SMOKE_BRIDGE_PORT || '', 10)
const token = process.env.UNIOPC_LOCAL_DOCUMENTS_TOKEN || ''
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
  throw new Error('runtime smoke bridge requires a valid port and loopback token')
}

const documents = new Map([
  ['doc-seed', {
    id: 'doc-seed',
    title: '种子文档',
    category: 'other',
    markdown: '# 种子文档',
    contentHash: 'hash-seed',
    status: 'active',
    version: 1,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  }],
])

function reply(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

function summary(document) {
  const { markdown: _markdown, ...metadata } = document
  return metadata
}

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    if (request.method !== 'POST' || request.url !== '/v1/documents/operation') {
      reply(response, 404, { error: { code: 'not_found', message: 'Not found.' } })
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      reply(response, 401, { error: { code: 'unauthorized', message: 'Authorization failed.' } })
      return
    }

    let envelope
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      reply(response, 400, { error: { code: 'invalid_request', message: 'Invalid request.' } })
      return
    }
    if (!envelope?.agent?.openclawProfile || !envelope?.session?.key) {
      reply(response, 400, { error: { code: 'invalid_request', message: 'Missing runtime context.' } })
      return
    }

    const payload = envelope.payload || {}
    let result
    if (envelope.action === 'uniopc_local_documents_list') {
      result = {
        documents: [...documents.values()]
          .filter(document => !payload.category || document.category === payload.category)
          .map(summary),
      }
    } else if (envelope.action === 'uniopc_local_document_get') {
      const document = documents.get(payload.id)
      if (!document) {
        reply(response, 404, { error: { code: 'document_not_found', message: 'The document was not found.' } })
        return
      }
      result = { document }
    } else if (envelope.action === 'uniopc_local_document_create') {
      const document = {
        id: 'doc-created',
        title: payload.title,
        category: payload.category,
        markdown: payload.markdown,
        metadata: payload.metadata || {},
        contentHash: 'hash-created',
        status: 'active',
        version: 1,
        createdAt: '2026-09-09T00:01:00.000Z',
        updatedAt: '2026-09-09T00:01:00.000Z',
      }
      documents.set(document.id, document)
      result = { document }
    } else if (envelope.action === 'uniopc_local_document_update') {
      const current = documents.get(payload.id)
      if (!current || payload.baseHash !== current.contentHash) {
        reply(response, 409, { error: { code: 'document_conflict', message: 'The document changed since it was opened.' } })
        return
      }
      const document = {
        ...current,
        title: payload.title,
        category: payload.category,
        markdown: payload.markdown,
        metadata: payload.metadata || {},
        contentHash: 'hash-updated',
        version: current.version + 1,
        updatedAt: '2026-09-09T00:02:00.000Z',
      }
      documents.set(document.id, document)
      result = { document }
    } else {
      reply(response, 400, { error: { code: 'invalid_action', message: 'Unsupported action.' } })
      return
    }

    process.stdout.write(`${JSON.stringify({ event: 'request', action: envelope.action })}\n`)
    reply(response, 200, result)
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ event: 'ready', port })}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
