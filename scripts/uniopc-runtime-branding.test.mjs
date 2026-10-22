import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

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
    await addLifecycleFixtures(root)
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

// Verbatim path functions from the installed pinned engine, independent of production constants.
const lifecycleReadableFixture = "function resolveLifecycleCoordinatorPath(family, params) {\n\tconst canonicalDatabasePath = resolvePathViaExistingAncestorSync(params.databasePath);\n\tconst canonicalRuntimeDirectory = resolvePathViaExistingAncestorSync(params.runtimeDirectory);\n\tconst suffix = params.uid === void 0 ? \"openclaw-state-locks\" : `openclaw-state-locks-${params.uid}`;\n\treturn path.join(canonicalRuntimeDirectory, suffix, `${family}.${sha256HexPrefixCore(canonicalDatabasePath, 8)}.lock.sqlite`);\n}"
const lifecycleWorkerFixture = "function resolveLifecycleCoordinatorPath(Ot,Zt){let _n=resolvePathViaExistingAncestorSync(Zt.databasePath),Dn=resolvePathViaExistingAncestorSync(Zt.runtimeDirectory),kn=Zt.uid===void 0?`openclaw-state-locks`:`openclaw-state-locks-${Zt.uid}`;return path.join(Dn,kn,`${Ot}.${sha256HexPrefixCore(_n,8)}.lock.sqlite`)}"
const lifecycleFixtures = [
  ['dist/state-database-coordinator-fixture.js', lifecycleReadableFixture],
  ['dist/config-doctor/official-external-plugin-catalog-snapshot-store-fixture.js', lifecycleReadableFixture],
  ['dist/worker/worker.mjs', lifecycleWorkerFixture],
]
async function addLifecycleFixtures(root, branded = false) {
  for (const [name, body] of lifecycleFixtures) {
    const path = join(root, name)
    await mkdir(join(path, '..'), {recursive: true})
    let existing = ''
    try { existing = await readFile(path, 'utf8') } catch {}
    await writeFile(path, existing + '\n' + (branded ? body.replaceAll('openclaw-state-locks', 'uniopc-state-locks') : body))
  }
}

test('lifecycle preflight rejects missing, duplicate, drifted and extra legacy suffixes without writes', async t => {
  for (const variant of ['missing', 'duplicate', 'duplicate-file', 'drift', 'extra', 'comment', 'string', 'nested']) {
    const root = await mkdtemp(join(tmpdir(), 'uniopc-lock-preflight-'))
    t.after(() => rm(root, {recursive: true, force: true}))
    await addLifecycleFixtures(root)
    await writeFile(join(root, 'dist/paths-fixture.js'), 'const suffix = uid != null ? `openclaw-${uid}` : "openclaw";')
    await writeFile(join(root, 'dist/openclaw-chunk.js'), 'const x = true;')
    const file = join(root, lifecycleFixtures[1][0])
    if (variant === 'missing') await rm(file)
    if (variant === 'duplicate') await writeFile(file, lifecycleReadableFixture + '\n' + lifecycleReadableFixture)
    if (variant === 'duplicate-file') await writeFile(join(root, 'dist/state-database-coordinator-duplicate.js'), 'const unused = true;')
    if (variant === 'drift') await writeFile(file, lifecycleReadableFixture.replace('canonicalDatabasePath, 8', 'canonicalDatabasePath, 9'))
    if (variant === 'comment') await writeFile(file, '/*' + lifecycleReadableFixture + '*/')
    if (variant === 'string') await writeFile(file, 'const fake = ' + JSON.stringify(lifecycleReadableFixture) + ';')
    if (variant === 'nested') await writeFile(file, 'function wrapper(){' + lifecycleReadableFixture + '}')
    if (variant === 'extra') await writeFile(join(root, 'dist/extra.js'), 'const x="openclaw-state-locks";')
    const snapshot = async () => {
      const result = []
      async function walk(dir) {
        for (const e of await readdir(dir, {withFileTypes:true})) {
          const path = join(dir, e.name)
          if (e.isDirectory()) await walk(path)
          else result.push([path, await readFile(path, 'utf8')])
        }
      }
      await walk(root)
      return result
    }
    const before = await snapshot()
    await assert.rejects(rebrandCompiledRuntimePaths(root), /Lifecycle coordinator/)
    assert.deepEqual(await snapshot(), before, variant)
  }
})

test('pinned main, config-doctor and worker derivations retain database hashes and both lifecycle families', () => {
  const databasePath = path.resolve('/state/main.sqlite')
  const runtimeDirectory = path.resolve('/profile/Uniopc/locks')
  const hash = createHash('sha256').update(databasePath).digest('hex').slice(0, 8)
  for (const [, body] of lifecycleFixtures) {
    const derive = new Function('path', 'resolvePathViaExistingAncestorSync', 'sha256HexPrefixCore',
      body.replaceAll('openclaw-state-locks', 'uniopc-state-locks') + ';return resolveLifecycleCoordinatorPath;')(
        path, path.resolve, (value, length) => createHash('sha256').update(value).digest('hex').slice(0, length))
    for (const uid of [undefined, 501]) for (const family of ['gateway-lifecycle', 'state-lifecycle']) {
      assert.equal(derive(family, {databasePath, runtimeDirectory, uid}),
        join(runtimeDirectory, `uniopc-state-locks${uid === undefined ? '' : '-501'}`, `${family}.${hash}.lock.sqlite`))
    }
  }
})


async function largeDistFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-rebrand-fd-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  await mkdir(join(root, 'dist'))
  // Fixture setup is sequential too: it must not exhaust the test runner's FDs.
  for (let index = 0; index < 1024; index++) {
    const extension = ['js', 'mjs', 'cjs', 'ts', 'mts', 'json', 'html', 'css', 'map'][index % 9]
    await writeFile(join(root, 'dist', `chunk-${String(index).padStart(4, '0')}.${extension}`), '"./openclaw-chunk.js"')
  }
  await addLifecycleFixtures(root)
  await writeFile(join(root, 'dist/openclaw-chunk.js'), 'const ready = true;')
  await writeFile(join(root, 'dist/paths-fixture.js'), 'const suffix = uid != null ? `openclaw-${uid}` : "openclaw";')
  return root
}

async function distSnapshot(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else files.push([path.relative(root, file), createHash('sha256').update(await readFile(file)).digest('hex')])
    }
  }
  await visit(join(root, 'dist'))
  return files.sort(([a], [b]) => a.localeCompare(b))
}

function transformWithLowFdLimit(moduleUrl, root) {
  const program = `import { rebrandCompiledRuntimePaths } from ${JSON.stringify(moduleUrl)};
try { await rebrandCompiledRuntimePaths(process.argv[1]); }
catch (error) { console.error(error.code || error.message); process.exitCode = 1; }`
  // Positional arguments avoid shell interpolation of paths or source code.
  return spawnSync('/bin/sh', ['-c', 'ulimit -n 64 || exit 90; exec "$@"', 'fd-limit-test',
    process.execPath, '--input-type=module', '-e', program, root], {encoding: 'utf8', timeout: 60000})
}

test('large dist preflight uses bounded file handles and preserves full coverage and idempotence', async t => {
  const root = await largeDistFixture(t)
  const before = await distSnapshot(root)
  if (process.platform !== 'win32') {
    // Reconstruct the previous unbounded reader without requiring Git history.
    // Run it only on the isolated fixture, never on an installed/live runtime.
    const currentSource = await readFile(new URL('./uniopc-runtime-branding.mjs', import.meta.url), 'utf8')
    const sequentialReader = "const sources = []\n  for (const path of textFiles) sources.push({path, source: await readFile(path, 'utf8')})"
    assert.equal(currentSource.split(sequentialReader).length, 2, 'bounded reader fixture anchor drift')
    const parentSource = currentSource.replace(sequentialReader,
      "const sources = await Promise.all(textFiles.map(async path => ({path, source: await readFile(path, 'utf8')})))")
      .replace(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, import.meta.url).href}'`)
    const parentModule = join(root, 'parent-branding.mjs')
    await writeFile(parentModule, parentSource)
    const oldResult = transformWithLowFdLimit(pathToFileURL(parentModule).href, root)
    assert.equal(oldResult.error, undefined)
    assert.notEqual(oldResult.status, 0)
    assert.match(oldResult.stderr, /EMFILE/)
    assert.deepEqual(await distSnapshot(root), before)
    t.diagnostic('Unbounded reader fixture under soft FD limit 64: EMFILE; fixture bytes and names unchanged')
    const result = transformWithLowFdLimit(new URL('./uniopc-runtime-branding.mjs', import.meta.url).href, root)
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    t.diagnostic('Current implementation under soft FD limit 64: success')
  } else {
    t.diagnostic('POSIX soft FD limit comparison unavailable on Windows; large-directory conversion still runs')
    await rebrandCompiledRuntimePaths(root)
  }
  const after = await distSnapshot(root)
  assert.ok(after.some(([name]) => name === 'dist/uniopc-chunk.js'))
  assert.ok(!after.some(([name]) => name === 'dist/openclaw-chunk.js'))
  for (const [name] of after.filter(([name]) => /chunk-\d+\./.test(name))) {
    assert.equal(await readFile(join(root, name), 'utf8'), '"./uniopc-chunk.js"')
  }
  assert.deepEqual(await rebrandCompiledRuntimePaths(root), [])
  assert.deepEqual(await distSnapshot(root), after)
})

test('large dist rejects a late extra lifecycle suffix before any byte or filename changes', async t => {
  const root = await largeDistFixture(t)
  await writeFile(join(root, 'dist/zzzz-last-chunk.js'), 'const unsupported = "openclaw-state-locks";')
  const before = await distSnapshot(root)
  await assert.rejects(rebrandCompiledRuntimePaths(root), /Lifecycle coordinator/)
  assert.deepEqual(await distSnapshot(root), before)
})
