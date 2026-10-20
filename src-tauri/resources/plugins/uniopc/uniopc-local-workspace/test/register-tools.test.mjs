import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalWorkspaceEntry } from '../src/index.ts'

function registeredTools(runners = {}) {
  const factories = []
  createLocalWorkspaceEntry(runners).register({
    pluginConfig: {},
    registerTool(factory) {
      factories.push(factory)
    },
    on() {},
  })
  return factories.map(factory => factory({
    session: { key: 'session-1' },
    openclawProfile: 'default',
    sessionKey: 'session-1',
  }))
}

test('document create accepts Markdown rather than a BlockSuite CRDT payload', async () => {
  const calls = []
  const [,, create] = registeredTools({
    callLocalDocument: async (...args) => {
      calls.push(args)
      return { document: { id: 'doc-1' } }
    },
  })

  assert.deepEqual(create.parameters.required, ['title', 'category', 'markdown'])
  assert.equal(create.parameters.properties.blocksuiteBody, undefined)
  await create.execute('call-1', {
    title: '本地工作区写入测试',
    category: 'other',
    markdown: '# 本地工作区写入测试\n\n- 正确显示',
  })
  assert.deepEqual(calls[0][1], {
    title: '本地工作区写入测试',
    category: 'other',
    markdown: '# 本地工作区写入测试\n\n- 正确显示',
  })
})

test('document update accepts Markdown and keeps conflict protection', async () => {
  const calls = []
  const [,,, update] = registeredTools({
    callLocalDocument: async (...args) => {
      calls.push(args)
      return { document: { id: 'doc-1' } }
    },
  })

  assert.deepEqual(update.parameters.required, ['id', 'title', 'category', 'markdown', 'baseHash'])
  await update.execute('call-2', {
    id: 'doc-1',
    title: '更新后的纪要',
    category: 'meeting',
    markdown: '# 更新后的纪要\n\n1. 继续跟进',
    baseHash: 'current-hash',
  })
  assert.deepEqual(calls[0][1], {
    id: 'doc-1',
    title: '更新后的纪要',
    category: 'meeting',
    markdown: '# 更新后的纪要\n\n1. 继续跟进',
    baseHash: 'current-hash',
  })
})

test('a direct local-workspace invocation keeps its current-turn authorization description', () => {
  const [, get] = registeredTools()

  assert.match(get.description, /user-requested \/ local-workspace call/)
})
