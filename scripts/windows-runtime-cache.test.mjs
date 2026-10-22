import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { runtimeCacheKey, runtimeProjection, parserLockClosure, moduleImports, legacySeedKey, verifyCachedRuntime, RUNTIME_CACHE_PATHS, RUNTIME_MODULES, RUNTIME_RECIPE, LEGACY_SEED_KEY } from './windows-runtime-cache.mjs'
import { OPENCLAW_RELEASE_NODE_VERSION } from './verify-openclaw-release-contract.mjs'
import { LIFECYCLE_PATH_READABLE_ORIGINAL, LIFECYCLE_PATH_WORKER_ORIGINAL } from './verify-uniopc-whitelabel-runtime.mjs'
const sourceRoot = resolve(import.meta.dirname, '..')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const inputs = [...RUNTIME_MODULES, 'scripts/windows-runtime-cache.mjs', 'src-tauri/Cargo.toml', 'package-lock.json']
  for (const file of inputs) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), await readFile(join(sourceRoot, file)))
  }
  return { root, inputs }
}
async function modify(root, file, update, run) {
  const original = await readFile(join(root, file), 'utf8')
  await writeFile(join(root, file), update(original))
  try { await run() } finally { await writeFile(join(root, file), original) }
}
test('V2 key is deterministic without installed dependencies; runtime modules, pins and policy invalidate it', async t => {
  const { root } = await fixture(t)
  const options = { projectRoot: root }
  const key = await runtimeCacheKey(options)
  assert.equal(await runtimeCacheKey(options), key)
  assert.match(key, /^uniopc-runtime-v2-win32-x64-openclaw-2026.8.1-node-24\.19\.0-[a-f0-9]{64}$/)
  assert.notEqual(await runtimeCacheKey({ ...options, platform: 'linux' }), key)
  assert.notEqual(await runtimeCacheKey({ ...options, arch: 'arm64' }), key)
  for (const file of [...RUNTIME_MODULES, 'scripts/windows-runtime-cache.mjs']) await modify(root, file, old => old + '\n// runtime change\n', async () => assert.notEqual(await runtimeCacheKey(options), key, file))
  await modify(root, 'src-tauri/Cargo.toml', old => old.replace('openclaw-version = "2026.8.1"', 'openclaw-version = "2026.8.2"'), async () => assert.notEqual(await runtimeCacheKey(options), key))
  await modify(root, 'scripts/verify-openclaw-release-contract.mjs', old => old.replace("'24.19.0'", "'24.20.0'"), async () => assert.match(await runtimeCacheKey(options), /node-24\.20\.0-/))
  assert.deepEqual(RUNTIME_RECIPE, ['scripts/build-openclaw-runtime-bundle.mjs', '--force', '--platform', 'win32', '--arch', 'x64'])
})
test('application versions, frontend, Rust, signing/Perl workflows, plugins, tests and unrelated dependencies preserve the key', async t => {
  const { root } = await fixture(t)
  const options = { projectRoot: root }, key = await runtimeCacheKey(options)
  const irrelevant = ['package.json', 'src/App.tsx', 'src-tauri/src/runtime.rs', 'src-tauri/Cargo.lock', 'src-tauri/tauri.windows.conf.json', 'scripts/unrelated.test.mjs', '.github/workflows/desktop-build-windows.yml', 'src-tauri/resources/plugins/uniopc/plugin/dist/index.js']
  for (const file of irrelevant) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), 'arbitrary changed application input') }
  await modify(root, 'src-tauri/Cargo.toml', old => old.replace('version = "0.4.19"', 'version = "9.9.9"') + '\n# unrelated metadata\n', async () => assert.equal(await runtimeCacheKey(options), key))
  await modify(root, 'package-lock.json', old => {
    const lock = JSON.parse(old); lock.version = '9.9.9'; lock.packages[''].version = '9.9.9'; lock.packages[''].devDependencies.vite = '99.0.0'; lock.packages['node_modules/vite'].version = '99.0.0'; return JSON.stringify(lock)
  }, async () => assert.equal(await runtimeCacheKey(options), key))
  assert.equal(await runtimeCacheKey(options), key)
})
test('lock projection binds physical runtime dependency closure, package bytes and dependency edges', async t => {
  const { root } = await fixture(t)
  const original = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const closure = parserLockClosure(original)
  assert.deepEqual(closure.packages.map(p => p.location), ['node_modules/@babel/helper-string-parser', 'node_modules/@babel/helper-validator-identifier', 'node_modules/@babel/parser', 'node_modules/@babel/types'])
  for (const name of closure.packages.map(p => p.location)) for (const field of ['version', 'integrity', 'resolved']) {
    const lock = structuredClone(original); lock.packages[name][field] += 'changed'; assert.notDeepEqual(parserLockClosure(lock), closure, `${name}:${field}`)
  }
  const nested = structuredClone(original)
  nested.packages['node_modules/@babel/parser/node_modules/@babel/types'] = structuredClone(original.packages['node_modules/@babel/types'])
  assert.notDeepEqual(parserLockClosure(nested), closure)
  const shadowed = structuredClone(original); shadowed.packages['scripts/node_modules/@babel/parser'] = structuredClone(original.packages['node_modules/@babel/parser']); assert.notDeepEqual(parserLockClosure(shadowed), closure)
  const edge = structuredClone(original); edge.packages['node_modules/@babel/parser'].dependencies['@babel/types'] = '^7.30.0'; assert.notDeepEqual(parserLockClosure(edge), closure)
  for (const mutate of [
    lock => { delete lock.packages['node_modules/@babel/types'] },
    lock => { lock.packages['node_modules/@babel/types'].link = true },
    lock => { delete lock.packages['node_modules/@babel/types'].integrity },
    lock => { delete lock.packages['node_modules/@babel/types'].resolved },
    lock => { lock.packages['node_modules/@babel/types'].dependencies.missing = '1' },
  ]) { const lock = structuredClone(original); mutate(lock); assert.throws(() => parserLockClosure(lock), /Missing|linked|Unresolved/) }
  const options = { projectRoot: root }, key = await runtimeCacheKey(options)
  await modify(root, 'package-lock.json', old => { const lock = JSON.parse(old); lock.packages['node_modules/@babel/parser'].version = '8.0.0'; return JSON.stringify(lock) }, async () => assert.notEqual(await runtimeCacheKey(options), key))
})
test('runtime import closure is complete and real imports cannot silently escape the key', async t => {
  const { root } = await fixture(t)
  assert.deepEqual(moduleImports(`import fs from 'node:fs'; const generated = 'import x from "fake"'; export { x } from './actual.mjs'`), ['./actual.mjs', 'node:fs'])
  assert.throws(() => moduleImports("const p = import('./dynamic.mjs')"), /dynamic dependency/)
  assert.equal((await runtimeProjection({ projectRoot: root })).modules.length, RUNTIME_MODULES.length)
  await modify(root, RUNTIME_MODULES[0], old => old + "\nimport extra from './unkeyed.mjs'\n", async () => assert.rejects(runtimeCacheKey({ projectRoot: root }), /import closure changed/))
  await rm(join(root, RUNTIME_MODULES[0])); await symlink(join(sourceRoot, RUNTIME_MODULES[0]), join(root, RUNTIME_MODULES[0]))
  await assert.rejects(runtimeCacheKey({ projectRoot: root }), /symlinks/)
})
test('one exact owner-main legacy seed is offered only for equal Git-object runtime projections', async t => {
  const { root, inputs } = await fixture(t)
  const saved = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file), 'utf8')])))
  saved.set('.github/workflows/prepare-windows-runtime.yml', 'run: npm run build:openclaw-runtime -- --force --platform win32 --arch x64\n')
  saved.set('package.json', JSON.stringify({ scripts: { 'build:openclaw-runtime': 'node scripts/build-openclaw-runtime-bundle.mjs' } }))
  const readLegacyInput = file => { if (!saved.has(file)) throw new Error('missing object'); return saved.get(file) }
  const opts = { projectRoot: root, readLegacyInput }
  assert.equal(await legacySeedKey(opts), LEGACY_SEED_KEY)
  assert.match(LEGACY_SEED_KEY, /-6d5c2ef2cad65aeb983b030065bf6522ec04a363e76f8bee48d03a5add40750d$/)
  await modify(root, RUNTIME_MODULES[0], old => old + '\n// changed engine\n', async () => assert.equal(await legacySeedKey(opts), ''))
  const seedWorkflow = saved.get('.github/workflows/prepare-windows-runtime.yml')
  saved.set('.github/workflows/prepare-windows-runtime.yml', seedWorkflow.replace('--force', '--changed-recipe')); assert.equal(await legacySeedKey(opts), '')
  saved.set('.github/workflows/prepare-windows-runtime.yml', seedWorkflow)
  saved.set('package.json', '{}'); assert.equal(await legacySeedKey(opts), '')
  assert.equal(await legacySeedKey({ projectRoot: root, readLegacyInput: () => { throw new Error('missing historical object') } }), '')
  assert.equal(await legacySeedKey(), '', 'runtime compatibility patch rejects stale pinned seed; fresh build required')
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

test('actual cache key, seed-key and verifier CLIs load in an isolated repo before npm install', async t => {
  const {root:temporaryRoot}=await fixture(t)
  const root=await realpath(temporaryRoot)
  // Copy only the real seed guard's Node-only import closure. These modules are
  // loaded by the actual seed-key CLI, not substitutes for production code.
  for(const file of [
    'public-release-guard.mjs','desktop-release-candidate.mjs','desktop-candidate-promotion.mjs',
    'desktop-release-settings.mjs','prepare-desktop-updater-release.mjs',
    'check-updater-signing-keys.mjs','ci-publish-desktop-artifacts.mjs','release-desktop-updater.mjs',
  ]) await writeFile(join(root,'scripts',file),await readFile(join(sourceRoot,'scripts',file)))
  execFileSync('git',['init','--quiet',root])
  const sourceObjects=execFileSync('git',['rev-parse','--git-path','objects'],{cwd:sourceRoot,encoding:'utf8'}).trim()
  await writeFile(join(root,'.git/objects/info/alternates'),resolve(sourceRoot,sourceObjects)+'\n')
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim()
  await mkdir(join(root,'.git/refs/remotes/origin'),{recursive:true})
  await writeFile(join(root,'.git/refs/remotes/origin/main'),head+'\n')
  const env={...process.env,GITHUB_REPOSITORY:'JohnRoosevelt/uniopc-desktop-builds',
    GITHUB_ACTOR:'JohnRoosevelt',GITHUB_TRIGGERING_ACTOR:'JohnRoosevelt',
    GITHUB_SHA:head,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main'}
  for(const key of Object.keys(env)) if(['NODE_PATH','NODE_OPTIONS','GITHUB_OUTPUT','GIT_DIR','GIT_WORK_TREE'].includes(key.toUpperCase())) delete env[key]
  const run=(script,args=[])=>execFileSync(process.execPath,[join(root,'scripts',script),...args],
    {cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim()
  assert.ok(!(await readdir(root)).includes('node_modules'))
  const expected=await runtimeCacheKey({projectRoot:root})
  assert.equal(run('windows-runtime-cache.mjs',['key']),expected)
  assert.equal(run('windows-runtime-cache.mjs',['seed-key']),'No compatible legacy seed; fresh build required')
  assert.equal(await legacySeedKey({projectRoot:root}),'')
  // Verifier exercises the real extracted archive path with built-ins only.
  const runtime=join(root,'src-tauri/resources/uniopc-engine-runtime')
  const stage=join(root,'verifier-stage/tools/node/node_modules/uniopc-engine/docs/reference/templates')
  await mkdir(stage,{recursive:true});await mkdir(runtime,{recursive:true})
  for(const name of ['AGENTS.md','SOUL.md','TOOLS.md','IDENTITY.md','USER.md','BOOTSTRAP.md']) await writeFile(join(stage,name),'Uniopc template')
  const engine=resolve(stage,'../../..')
  const lifecycleFixtures=[
    ['dist/state-database-coordinator-fixture.js',LIFECYCLE_PATH_READABLE_ORIGINAL],
    ['dist/config-doctor/official-external-plugin-catalog-snapshot-store-fixture.js',LIFECYCLE_PATH_READABLE_ORIGINAL],
    ['dist/worker/worker.mjs',LIFECYCLE_PATH_WORKER_ORIGINAL],
  ]
  for(const [file,original] of lifecycleFixtures){const path=join(engine,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,original.replaceAll('openclaw-state-locks','uniopc-state-locks'))}
  execFileSync('tar',['-czf',join(runtime,'uniopc-engine-runtime-darwin-x64.tar.gz'),'-C',join(root,'verifier-stage'),'tools'])
  await writeFile(join(runtime,'uniopc-engine-runtime.catalog.json'),JSON.stringify({artifacts:[{platform:'darwin',arch:'x64',archive:'uniopc-engine-runtime-darwin-x64.tar.gz'}]}))
  assert.match(run('verify-uniopc-whitelabel-runtime.mjs',[runtime]),/branding verified \(1 artifact\(s\)\)/)
  assert.ok(!(await readdir(root)).includes('node_modules'))
  assert.equal((await runtimeProjection({projectRoot:root})).modules.length,RUNTIME_MODULES.length)
  const verifierImports=moduleImports(await readFile(join(root,'scripts/verify-uniopc-whitelabel-runtime.mjs'),'utf8'))
  assert.ok(verifierImports.every(dependency=>dependency.startsWith('node:') || dependency === './uniopc-skill-branding.mjs'))
  assert.ok(!verifierImports.includes('node:vm'),'VM named import is confined to the flagged child script')
})
