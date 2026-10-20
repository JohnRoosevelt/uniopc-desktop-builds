#!/usr/bin/env node
// Explicit local integration check: use an extracted managed archive, never a
// user's live runtime or profile. No model calls or network login are required.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtime = resolve(process.argv[2] || '')
assert.ok(process.argv[2], 'Pass an extracted managed runtime root containing tools/')
const directories = await readdir(join(runtime, 'tools'))
const nodeDirectory = directories.find(name => name.startsWith('node-v')) || directories.find(name => name === 'node')
const nodeRoot = join(runtime, 'tools', nodeDirectory)
const windows = nodeDirectory === 'node'
const node = join(nodeRoot, windows ? 'node.exe' : 'bin/node')
const engine = join(nodeRoot, ...(windows ? [] : ['lib']), 'node_modules/uniopc-engine')
let loaderName
for (const name of await readdir(join(engine, 'dist'))) {
  if (/^manifest-.*\.js$/.test(name) && (await readFile(join(engine, 'dist', name), 'utf8')).includes('function loadPluginManifest(')) { loaderName = name; break }
}
assert.ok(loaderName, 'Pinned manifest loader must be present')
const { r: loadManifest } = await import(pathToFileURL(join(engine, 'dist', loaderName)))
const extensions = join(engine, 'dist/extensions')
let manifests = 0
for (const name of await readdir(extensions)) {
  const root = join(extensions, name)
  if (!(await readFile(join(root, 'uniopc.plugin.json')).catch(() => null))) continue
  const result = loadManifest(root, false)
  assert.equal(result.ok, true, `${name}: ${result.error}`)
  manifests++
}
assert.ok(manifests >= 59, `Expected pinned engine's 59 bundled manifests, found ${manifests}`)
const work = await mkdtemp(join(tmpdir(), 'uniopc-plugin-manifest-check-'))
const resources = resolve('src-tauri/resources/plugins/uniopc')
const ids = ['uniopc-local-workspace', 'uniopc-documents', 'uniopc-presentations']
function list(config, profile) {
  const output = execFileSync(node, [join(engine, 'uniopc-engine.mjs'), 'plugins', 'list', '--json'], {
    env: { ...process.env, HOME: profile, OPENCLAW_STATE_DIR: profile, OPENCLAW_CONFIG_PATH: config, UNIOPC_DATA_DIR: profile },
    encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })
  assert.ok(output.length, 'Packaged CLI must execute; cached --help is insufficient')
  return JSON.parse(output)
}
try {
  const config = join(work, 'config.json')
  await writeFile(config, JSON.stringify({ plugins: { load: { paths: ids.map(id => join(resources, id)) } } }))
  const report = list(config, work)
  const loaded = ids.map(id => {
    const plugin = report.plugins.find(item => item.id === id)
    assert.equal(plugin?.status, 'loaded', `${id}: ${JSON.stringify(plugin)}`)
    assert.ok(plugin.toolNames.length, `${id} must register its tools`)
    return { id, status: plugin.status, tools: plugin.toolNames }
  })
  const legacy = join(work, 'legacy-documents')
  await cp(join(resources, 'uniopc-documents'), legacy, { recursive: true })
  await rename(join(legacy, 'uniopc.plugin.json'), join(legacy, 'openclaw.plugin.json'))
  await writeFile(config, JSON.stringify({ plugins: { load: { paths: [legacy] } } }))
  const oldReport = list(config, work)
  assert.equal(oldReport.plugins.find(item => item.id === 'uniopc-documents')?.status, 'loaded')
  await readFile(join(legacy, 'openclaw.plugin.json')) // read-only fallback preserved it
  // Exercise real authoring commands against an old project. Keep its legacy
  // file immutable as read input, while build must emit only the new filename.
  const authoring = join(work, 'authoring')
  await mkdir(authoring)
  await writeFile(join(authoring, 'package.json'), JSON.stringify({name: 'uniopc-authoring-check', type: 'module', version: '1.0.0', openclaw: {extensions: ['./index.mjs']}}))
  const sdk = (await readdir(join(engine, 'dist'))).find(name => /^tool-plugin-.*\.js$/.test(name))
  await writeFile(join(authoring, 'index.mjs'), `import {t as defineToolPlugin} from ${JSON.stringify(pathToFileURL(join(engine, 'dist', sdk)).href)};\nexport default defineToolPlugin({id:'authoring-check',name:'Authoring Check',description:'Local test',tools:()=>[]});`)
  const env = {...process.env, HOME: work, OPENCLAW_STATE_DIR: work, OPENCLAW_CONFIG_PATH: config, UNIOPC_DATA_DIR: work}
  function authorCommand(command, ...options) {
    return execFileSync(node, [join(engine, 'uniopc-engine.mjs'), 'plugins', command, '--root', authoring, '--entry', 'index.mjs', ...options], {env, encoding: 'utf8', timeout:60000, maxBuffer:2*1024*1024})
  }
  authorCommand('build')
  const generated = await readFile(join(authoring, 'uniopc.plugin.json'), 'utf8')
  await rename(join(authoring, 'uniopc.plugin.json'), join(authoring, 'openclaw.plugin.json'))
  // This validate runs before rebuilding, so a branded sibling cannot mask a
  // broken legacy-only read path.
  const validation = JSON.parse(authorCommand('validate', '--json'))
  assert.equal(validation.valid, true)
  assert.equal(await readFile(join(authoring, 'uniopc.plugin.json')).catch(() => null), null)
  authorCommand('build')
  assert.equal(await readFile(join(authoring, 'openclaw.plugin.json'), 'utf8'), generated)
  assert.equal(await readFile(join(authoring, 'uniopc.plugin.json'), 'utf8'), generated)
  console.log(JSON.stringify({ bundledManifestsLoaded: manifests, loaded, legacyPluginLoaded: true, legacyAuthoringValidation: true, legacyAuthoringBuildWritesBranded: true }, null, 2))
} finally { await rm(work, { recursive: true, force: true }) }
