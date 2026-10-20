import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { presentationsRoot, prepareBundledPluginDependencies } from './prepare-bundled-plugin-dependencies.mjs'

test('packaged PPT plugin loads and produces a PPTX without node_modules or network installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-offline-ppt-'))
  const plugin = join(root, 'plugin')
  const previousState = process.env.OPENCLAW_STATE_DIR
  try {
    await cp(presentationsRoot, plugin, { recursive: true, filter: path => !path.includes('/lib/') && !path.endsWith('/lib') })
    const pkg = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'))
    assert.equal(Object.keys(pkg.dependencies || {}).length, 0, 'user install must not fetch npm dependencies')
    await prepareBundledPluginDependencies({ pluginRoot: plugin })
    const { default: entry } = await import(pathToFileURL(join(plugin, 'index.js')).href)
    let tool
    entry.register({ registerTool(factory) { tool = factory() } })
    assert.equal(tool.name, 'uniopc_presentations_create_pptx')
    process.env.OPENCLAW_STATE_DIR = join(root, 'state')
    const result = await tool.execute('offline-smoke', { title: 'Offline test', slides: [{ title: 'Hello', body: 'Bundled dependency works.' }] })
    const pptx = await readFile(result.details.path)
    assert.equal(pptx.subarray(0, 2).toString(), 'PK')
    assert.ok(pptx.includes(Buffer.from('ppt/presentation.xml')))
    assert.ok(pptx.includes(Buffer.from('ppt/slides/slide1.xml')))
  } finally {
    if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR
    else process.env.OPENCLAW_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
  }
})
