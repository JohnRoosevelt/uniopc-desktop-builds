import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { runtimeCacheKey, verifyCachedRuntime, RUNTIME_CACHE_PATHS } from './windows-runtime-cache.mjs'
import { OPENCLAW_RELEASE_NODE_VERSION } from './verify-openclaw-release-contract.mjs'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const inputs = ['package.json', 'package-lock.json', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json', 'scripts/build.mjs', 'scripts/nested/verify.mjs', '.github/workflows/desktop-release.yml', '.github/workflows/prepare-windows-runtime.yml', 'src-tauri/src/runtime.rs', 'src-tauri/resources/plugins/uniopc/plugin/dist/index.js', 'src-tauri/resources/plugins/uniopc/plugin/package-lock.json']
  for (const file of inputs) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), '{}') }
  await writeFile(join(root, 'src-tauri/Cargo.toml'), '[package.metadata.uniopc]\nopenclaw-version = "2026.8.1"\n')
  return { root, inputs: [...inputs, 'src-tauri/Cargo.toml'] }
}
test('content key is deterministic, target/pin-specific and invalidates for every release input', async t => {
  const { root, inputs } = await fixture(t)
  const options = { projectRoot: root }
  const key = await runtimeCacheKey(options)
  assert.equal(await runtimeCacheKey(options), key)
  assert.match(key, /win32-x64-openclaw-2026.8.1-node-24\.19\.0-[a-f0-9]{64}$/)
  assert.notEqual(await runtimeCacheKey({ ...options, platform: 'linux' }), key)
  assert.notEqual(await runtimeCacheKey({ ...options, arch: 'arm64' }), key)
  for (const file of inputs) {
    const old = await readFile(join(root, file))
    await writeFile(join(root, file), Buffer.concat([old, Buffer.from('\n# changed')]))
    assert.notEqual(await runtimeCacheKey(options), key, file)
    await writeFile(join(root, file), old)
  }
  await writeFile(join(root, 'scripts/new-verifier.mjs'), 'new input')
  assert.notEqual(await runtimeCacheKey(options), key)
  await rm(join(root, 'scripts/new-verifier.mjs'))
  await mkdir(join(root, 'scripts/node_modules/ignored'), { recursive: true })
  await writeFile(join(root, 'scripts/node_modules/ignored/a'), 'generated')
  assert.equal(await runtimeCacheKey(options), key)
  await symlink(join(root, 'package.json'), join(root, 'scripts/link.mjs'))
  await assert.rejects(runtimeCacheKey(options), /symlink/)
})
test('cache validation checks real hashes before branding and propagates all failures', async t => {
  const { root } = await fixture(t)
  const directory = dirname(join(root, RUNTIME_CACHE_PATHS[0]))
  await mkdir(directory, { recursive: true })
  const packageDir = join(root, 'archive/tools/node/node_modules/uniopc-engine')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.8.1', bin: { 'uniopc-engine': 'uniopc-engine.mjs' }, exports: { './cli-entry': './uniopc-engine.mjs' } }))
  await writeFile(join(packageDir, 'uniopc-engine.mjs'), '#!/usr/bin/env node\n')
  execFileSync('tar', ['-czf', join(root, RUNTIME_CACHE_PATHS[0]), '-C', join(root, 'archive'), 'tools'])
  const bytes = await readFile(join(root, RUNTIME_CACHE_PATHS[0]))
  await writeFile(join(root, RUNTIME_CACHE_PATHS[1]), JSON.stringify({ artifacts: [{ platform: 'win32', arch: 'x64', version: '2026.8.1', nodeVersion: OPENCLAW_RELEASE_NODE_VERSION, archive: 'uniopc-engine-runtime-win32-x64.tar.gz', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }))
  let branded = 0
  const opts = { projectRoot: root, verifyBranding: async dir => { assert.equal(dir, directory); branded++ } }
  await verifyCachedRuntime(opts)
  assert.equal(branded, 1)
  await assert.rejects(verifyCachedRuntime({ ...opts, verifyBranding: async () => { throw new Error('unbranded') } }), /unbranded/)
  await writeFile(join(root, RUNTIME_CACHE_PATHS[0]), 'corrupt')
  await assert.rejects(verifyCachedRuntime(opts), /size mismatch/)
  assert.equal(branded, 1)
  await rm(join(root, RUNTIME_CACHE_PATHS[0]))
  await assert.rejects(verifyCachedRuntime(opts), /ENOENT/)
})
