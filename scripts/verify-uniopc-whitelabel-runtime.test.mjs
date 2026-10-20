import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertRuntimeEntryNamesBranded,
  assertRuntimeTextBranded,
  assertRuntimeWorkspaceTemplatesPackaged,
  classifyInternalTextPath,
  listResidualRuntimePaths,
} from './verify-uniopc-whitelabel-runtime.mjs'

test('runtime archive retains the workspace templates required for first launch', () => {
  const directory = 'tools/node-v24/lib/node_modules/uniopc-engine/docs/reference/templates/'
  const names = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md'].map(name => `${directory}${name}`)
  assertRuntimeWorkspaceTemplatesPackaged(names)
  assert.throws(() => assertRuntimeWorkspaceTemplatesPackaged(names.filter(name => !name.endsWith('AGENTS.md'))), /AGENTS.md/)
})

test('runtime path scan rejects the upstream engine directory and upstream scoped SDK dependencies', () => {
  assertRuntimeEntryNamesBranded([
    'bin/uniopc-engine',
    'tools/node/lib/node_modules/@uniopc/ai/dist/index.js',
    'tools/node-v24/lib/node_modules/uniopc-engine/dist/extensions/telegram/uniopc.plugin.json',
  ])
  assert.throws(() => assertRuntimeEntryNamesBranded(['tools/node/lib/node_modules/openclaw/openclaw.mjs']), /Unbranded runtime path/)
  assert.throws(() => assertRuntimeEntryNamesBranded(['tools/node-v24/lib/node_modules/uniopc-engine/openclaw.mjs']), /Unbranded runtime path/)
  assert.throws(() => assertRuntimeEntryNamesBranded(['tools/node-v24/lib/node_modules/uniopc-engine/dist/openclaw-root-HASH.js']), /Unbranded runtime path/)
  assert.throws(() => assertRuntimeEntryNamesBranded(['tools/node-v24/lib/node_modules/uniopc-engine/dist/extensions/demo/assets/openclaw-wallpaper.png']), /Unbranded runtime path/)
  assert.throws(() => assertRuntimeEntryNamesBranded(['tools/node-v24/lib/node_modules/uniopc-engine/dist/extensions/demo/openclaw.plugin.json']), /Unbranded runtime path/)
  for (const root of ['tools/node/node_modules', 'tools/node-v24/lib/node_modules/uniopc-engine/node_modules']) {
    assert.throws(() => assertRuntimeEntryNamesBranded([`${root}/@openclaw/ai/dist/index.js`]), /Unbranded runtime path/)
    assert.throws(() => assertRuntimeEntryNamesBranded([`${root}/@openclaw/`]), /Unbranded runtime path/)
  }
  assert.throws(() => assertRuntimeEntryNamesBranded(['bin/openclaw']), /Unbranded runtime path/)
  assert.throws(() => assertRuntimeEntryNamesBranded(['小龙虾.log']), /Unbranded runtime path/)
})

test('runtime path report enumerates every exact upstream path residual', () => {
  assert.deepEqual(listResidualRuntimePaths([
    'tools/node/lib/node_modules/@openclaw/ai/dist/index.js',
    'tools/node/lib/node_modules/@openclaw/fs-safe/package.json',
    'tools/node-v24/lib/node_modules/uniopc-engine/dist/extensions/telegram/openclaw.plugin.json',
    'bin/uniopc-engine',
  ]), [
    'tools/node-v24/lib/node_modules/uniopc-engine/dist/extensions/telegram/openclaw.plugin.json',
    'tools/node/lib/node_modules/@openclaw/ai',
    'tools/node/lib/node_modules/@openclaw/fs-safe',
  ])
})

test('scanner classifies only compiled Control UI code as internal source', () => {
  assert.match(
    classifyInternalTextPath('tools/node-v24/lib/node_modules/uniopc-engine/dist/control-ui-entry.js'),
    /internal API\/property identifiers/
  )
  assert.equal(classifyInternalTextPath('tools/node-v24/lib/node_modules/uniopc-engine/dist/channel-catalog.json'), null)
})

test('runtime text scan rejects display branding and permits only declared attribution headers', () => {
  assertRuntimeTextBranded('Uniopc gateway ready')
  assertRuntimeTextBranded('OPENCLAW_ATTRIBUTION_PRODUCT = "OpenClaw"')
  assert.throws(() => assertRuntimeTextBranded('OpenClaw gateway ready'), /Unbranded user-facing runtime string/)
  assert.throws(() => assertRuntimeTextBranded('小龙虾已启动'), /Unbranded user-facing runtime string/)
})
