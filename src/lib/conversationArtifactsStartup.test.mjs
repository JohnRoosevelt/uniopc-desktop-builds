import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'

const source = fs.readFileSync(new URL('../components/ConversationArtifactsSlot.jsx', import.meta.url), 'utf8')
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] })
const traverse = traverseModule.default ?? traverseModule
let refreshSource
traverse(ast, {
  VariableDeclarator(path) {
    if (path.node.id.name === 'refresh') {
      const callback = path.node.init.arguments[0]
      refreshSource = source.slice(callback.start, callback.end)
    }
  },
})

function harness(gatewayReady) {
  const state = { requests: 0, items: [], total: 0 }
  const refresh = vm.runInNewContext(`(${refreshSource})`, {
    gatewayReady, ownerId: 'owner', conversationId: 'chat', sessionKey: 'agent:main:main', profile: 'profile',
    MAX_SLOT_ITEMS: 6, Map, Array,
    listStoredToolArtifacts: () => [{ conversationId: 'chat', path: '/local/result.txt' }],
    toolArtifactsToPanelItems: entries => entries,
    engineFilesToPanelItems: files => files,
    listConversationSessionFiles: async () => { state.requests++; return [{ path: '/engine/result.txt' }] },
    invoke: async () => [
      { path: '/local/result.txt', exists: true, size: 20 },
      { path: '/engine/result.txt', exists: true, size: 30 },
    ],
    setItems: items => { state.items = items }, setTotal: total => { state.total = total },
  })
  return { refresh, state }
}

test('artifact refresh keeps local files visible without waking an unready engine', async () => {
  const { refresh, state } = harness(false)
  refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.requests, 0)
  assert.deepEqual(Array.from(state.items, item => item.path), ['/local/result.txt'])
})

test('ready artifact refresh merges engine files with local files', async () => {
  const { refresh, state } = harness(true)
  refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.requests, 1)
  assert.equal(state.total, 2)
})
