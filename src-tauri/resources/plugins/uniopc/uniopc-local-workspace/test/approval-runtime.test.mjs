import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalWorkspaceEntry } from '../src/index.ts'

async function registeredTools(callLocalDocument) {
  const factories = []
  const entry = createLocalWorkspaceEntry({ callLocalDocument })
  entry.register({
    pluginConfig: {},
    registerTool(factory) {
      factories.push(factory)
    },
    on() {},
  })
  return factories.map(factory => factory({
    openclawProfile: 'review-profile',
    session: { key: 'review-session' },
    sessionKey: 'review-session',
  }))
}

test('a direct local-workspace invocation runs each requested write exactly once', async () => {
  const calls = []
  const tools = await registeredTools(async (action, payload) => {
    calls.push({ action, payload })
    return { document: { id: `${action}-${calls.length}` } }
  })
  const create = tools.find(tool => tool.name === 'uniopc_local_document_create')
  const update = tools.find(tool => tool.name === 'uniopc_local_document_update')
  assert.ok(create)
  assert.ok(update)

  for (const [tool, toolCallId, params, expectedAction] of [
    [create, 'create', {
        title: '审批后创建',
        category: 'other',
        markdown: '# 审批后创建',
      }, 'uniopc_local_document_create'],
    [update, 'update', {
        id: 'doc-1',
        title: '审批后更新',
        category: 'other',
        markdown: '# 审批后更新',
        baseHash: 'hash-1',
      }, 'uniopc_local_document_update'],
  ]) {
    const before = calls.length
    const result = await tool.execute(toolCallId, params)
    assert.equal(calls.length, before + 1)
    assert.equal(calls.at(-1).action, expectedAction)
    assert.equal(result.details.document.id, `${expectedAction}-${calls.length}`)
  }
  assert.equal(calls.filter(call => call.action === 'uniopc_local_document_create').length, 1)
  assert.equal(calls.filter(call => call.action === 'uniopc_local_document_update').length, 1)
})
