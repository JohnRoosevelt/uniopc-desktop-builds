import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const sourceEntry = new URL('../src/index.ts', import.meta.url)

async function loadEntryModule() {
  assert.equal(existsSync(sourceEntry), true, 'the OpenClaw 2 TypeScript entry must exist')
  return import(sourceEntry)
}

async function registeredTools(caller) {
  const { registrations } = await registeredPlugin(caller)
  return registrations
}

async function registeredPlugin(caller) {
  const { createLocalWorkspaceEntry } = await loadEntryModule()
  const registrations = []
  const hooks = []
  const entry = createLocalWorkspaceEntry({ callLocalDocument: caller })
  entry.register({
    pluginConfig: {},
    registerTool(tool, options) {
      registrations.push({ tool, options })
    },
    on(hookName, handler, options) {
      hooks.push({ hookName, handler, options })
    },
  })
  return { registrations, hooks }
}

test('the TypeScript entry exposes four strict host-auditable schemas without host imports', async () => {
  const { default: entry } = await loadEntryModule()
  const metadata = entry[Symbol.for('openclaw.plugin-sdk.tool-plugin.metadata')]

  assert.deepEqual(metadata.tools.map((tool) => tool.name), [
    'uniopc_local_documents_list',
    'uniopc_local_document_get',
    'uniopc_local_document_create',
    'uniopc_local_document_update',
  ])
  for (const tool of metadata.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
  }
  assert.deepEqual(metadata.tools[0].parameters.required, [])
  assert.deepEqual(metadata.tools[1].parameters.required, ['id'])
  assert.deepEqual(metadata.tools[2].parameters.required, ['title', 'category', 'markdown'])
  assert.deepEqual(metadata.tools[3].parameters.required, ['id', 'title', 'category', 'markdown', 'baseHash'])
})

test('tool factories preserve payloads, per-turn context, abort signals, and JSON results', async () => {
  const calls = []
  const registrations = await registeredTools(async (...args) => {
    calls.push(args)
    return { documents: [{ id: 'doc-1', title: '计划' }] }
  })
  const controller = new AbortController()
  const toolContext = {
    agentId: 'agent-7',
    sessionKey: 'session-9',
  }
  const list = registrations[0].tool(toolContext)
  const result = await list.execute('call-1', { category: 'meeting' }, controller.signal)

  assert.deepEqual(registrations.map(({ options }) => options), [
    { name: 'uniopc_local_documents_list' },
    { name: 'uniopc_local_document_get' },
    { name: 'uniopc_local_document_create' },
    { name: 'uniopc_local_document_update' },
  ])
  assert.deepEqual(calls, [[
    'uniopc_local_documents_list',
    { category: 'meeting' },
    { runtimeContext: toolContext, signal: controller.signal },
  ]])
  assert.deepEqual(result.details, { documents: [{ id: 'doc-1', title: '计划' }] })
  assert.deepEqual(JSON.parse(result.content[0].text), result.details)
})

test('runtime tools preserve read and write safety annotations', async () => {
  const registrations = await registeredTools(async () => ({}))
  const runtimeContext = { agentId: 'agent-7', sessionKey: 'session-9' }
  const annotations = registrations.map(({ tool }) => tool(runtimeContext).annotations)

  assert.deepEqual(annotations, [
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  ])
})

test('a direct local-workspace invocation does not add a generic approval hook', async () => {
  const { hooks } = await registeredPlugin(async () => ({}))
  assert.deepEqual(hooks, [])
})
