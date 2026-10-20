import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rebrandEngineWrapperContract, rebrandPluginManifestPaths, rebrandCompiledRuntimePaths, rebrandDisplayMetadata, rebrandVisibleText } from './uniopc-runtime-branding.mjs'

test('rebrands visible names while preserving derived machine identifiers', () => {
  assert.equal(rebrandVisibleText('OpenClaw OPENCLAW 小龙虾 OpenClawConfig'), 'Uniopc Uniopc Uniopc OpenClawConfig')
})

test('rebrands UI metadata fields without changing package identity or protocol fields', () => {
  assert.deepEqual(rebrandDisplayMetadata({
    name: '@openclaw/channel',
    npmSpec: '@openclaw/channel',
    description: 'OpenClaw channel plugin',
    channel: { label: 'OpenClaw Chat' },
  }), {
    name: '@openclaw/channel',
    npmSpec: '@openclaw/channel',
    description: 'Uniopc channel plugin',
    channel: { label: 'Uniopc Chat' },
  })
})

test('rebrands browser extension display name while retaining upstream technical IDs elsewhere', () => {
  assert.deepEqual(rebrandDisplayMetadata({
    name: 'OpenClaw Helper',
    description: 'OpenClaw companion',
    default_locale: 'en',
  }, { browserManifest: true }), {
    name: 'Uniopc Helper',
    description: 'Uniopc companion',
    default_locale: 'en',
  })
})

test('rebrands cached CLI help shown on startup', () => {
  assert.deepEqual(rebrandDisplayMetadata({
    rootHelpText: 'OpenClaw 2026.8.1 — All your chats, one OpenClaw.\nUsage: openclaw [options]\nDocs: https://docs.openclaw.ai',
    subcommandHelpText: { plugins: 'OpenClaw plugins\nUsage: openclaw plugins\nDocs: https://docs.openclaw.ai' },
  }), {
    rootHelpText: 'Uniopc 2026.8.1 — All your chats, one Uniopc.\nUsage: uniopc-engine [options]\nDocs: https://docs.openclaw.ai',
    subcommandHelpText: { plugins: 'Uniopc plugins\nUsage: uniopc-engine plugins\nDocs: https://docs.openclaw.ai' },
  })
})

test('renames compiled chunks and references while preserving plugin manifest names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-rebrand-chunk-test-'))
  try {
    const dist = join(root, 'dist')
    await mkdir(join(dist, 'extensions', 'demo'), { recursive: true })
    await writeFile(join(dist, 'openclaw-root-HASH.js'), 'export const ready = true')
    await writeFile(join(dist, 'entry.js'), 'import "./openclaw-root-HASH.js"; const wallpaper = "./openclaw-wallpaper.png"')
    await writeFile(join(dist, 'openclaw-wallpaper.png'), Buffer.from([137, 80, 78, 71]))
    await writeFile(join(dist, 'paths-HASH.js'), 'const suffix = uid != null ? `openclaw-${uid}` : "openclaw";')
    await writeFile(join(dist, 'extensions', 'demo', 'openclaw.plugin.json'), '{}')
    await rebrandCompiledRuntimePaths(root)
    assert.ok((await readdir(dist)).includes('uniopc-root-HASH.js'))
    assert.ok((await readdir(dist)).includes('uniopc-wallpaper.png'))
    assert.match(await readFile(join(dist, 'entry.js'), 'utf8'), /uniopc-root-HASH\.js/)
    assert.match(await readFile(join(dist, 'entry.js'), 'utf8'), /uniopc-wallpaper\.png/)
    assert.match(await readFile(join(dist, 'paths-HASH.js'), 'utf8'), /`uniopc-\$\{uid\}` : "uniopc"/)
    assert.ok((await readdir(join(dist, 'extensions', 'demo'))).includes('openclaw.plugin.json'))
    assert.deepEqual(await rebrandCompiledRuntimePaths(root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('manifest transform supports executable discovery, legacy reads, idempotence and collision rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-manifest-contract-'))
  try {
    const dist = join(root, 'dist')
    const plugin = join(dist, 'extensions', 'demo')
    await mkdir(plugin, { recursive: true })
    await writeFile(join(plugin, 'openclaw.plugin.json'), '{"id":"demo"}')
    const loader = join(dist, 'manifest-HASH.mjs')
    await writeFile(loader, `import path from "node:path";
import {readFileSync} from "node:fs";
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
function readPluginCacheFile(p) { return JSON.parse(readFileSync(path.join(p.rootDir, p.relativePath), "utf8")); }
export function loadPluginManifest(rootDir, rejectHardlinks = true, rootRealPath) {
 const manifestPath = path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
 return readPluginCacheFile({rootDir, relativePath: PLUGIN_MANIFEST_FILENAME,});
}
export function discover(root) { return JSON.parse(readFileSync(path.join(root, "openclaw.plugin.json"), "utf8")); }
`)
    assert.equal((await rebrandPluginManifestPaths(root)).renamed, 1)
    const {loadPluginManifest, discover} = await import(loader)
    assert.equal(loadPluginManifest(plugin).id, 'demo')
    assert.equal(discover(plugin).id, 'demo')
    await writeFile(join(root, 'openclaw.plugin.json'), '{"id":"existing-user-plugin"}')
    assert.equal(loadPluginManifest(root).id, 'existing-user-plugin')
    assert.equal(discover(root).id, 'existing-user-plugin')
    // Leave the read-only compatibility fixture outside the staged artifact.
    await rm(join(root, 'openclaw.plugin.json'))
    assert.deepEqual(await rebrandPluginManifestPaths(root), {renamed: 0, patched: 0})
    await writeFile(join(plugin, 'openclaw.plugin.json'), '{"id":"conflict"}')
    await assert.rejects(rebrandPluginManifestPaths(root), /collision/)
    assert.equal(JSON.parse(await readFile(join(plugin, 'uniopc.plugin.json'), 'utf8')).id, 'demo')
  } finally { await rm(root, {recursive: true, force: true}) }
})


test('wrapper contract repair is idempotent and rejects unsupported entry layouts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-wrapper-contract-'))
  try {
    await mkdir(join(root, 'dist'))
    const entry = join(root, 'dist', 'entry.js')
    await writeFile(entry, 'const a={wrapperBasename: "openclaw.mjs"};const b={wrapperBasename: "openclaw.mjs"};')
    await rebrandEngineWrapperContract(root)
    const branded = await readFile(entry, 'utf8')
    assert.equal(branded.includes('openclaw.mjs'), false)
    await rebrandEngineWrapperContract(root)
    assert.equal(await readFile(entry, 'utf8'), branded)
    await writeFile(entry, 'new unsupported entry')
    await assert.rejects(rebrandEngineWrapperContract(root), /wrapper contract changed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
