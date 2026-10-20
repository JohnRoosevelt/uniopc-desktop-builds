#!/usr/bin/env node
// V2 keys only the Windows runtime production/verification closure. No installed
// packages are required to project package-lock.json or to verify cache hits.
import { createHash } from 'node:crypto'
import { readFile, lstat, appendFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyReleaseContract } from './verify-openclaw-release-contract.mjs'
import { verifyRuntimeDirectory } from './verify-uniopc-whitelabel-runtime.mjs'
const ROOT = resolve(import.meta.dirname, '..')
export const RUNTIME_MODULES = [
  'scripts/build-openclaw-runtime-bundle.mjs',
  'scripts/uniopc-runtime-scopes.mjs',
  'scripts/uniopc-runtime-branding.mjs',
  'scripts/verify-openclaw-release-contract.mjs',
  'scripts/verify-uniopc-whitelabel-runtime.mjs',
]
export const RUNTIME_RECIPE = ['scripts/build-openclaw-runtime-bundle.mjs', '--force', '--platform', 'win32', '--arch', 'x64']
export const LEGACY_SEED_COMMIT = '7a708bfcb7999ac36233c80075fa5a21d0519c1e'
// Saved by owner-main warm run 39405727143, job 118571060944. This is
// deliberately one exact cache, never a prefix or candidate fallback.
export const LEGACY_SEED_KEY = 'uniopc-runtime-v1-win32-x64-openclaw-2026.8.1-node-24.19.0-6d5c2ef2cad65aeb983b030065bf6522ec04a363e76f8bee48d03a5add40750d'
export const RUNTIME_CACHE_PATHS = [
  'src-tauri/resources/uniopc-engine-runtime/uniopc-engine-runtime-win32-x64.tar.gz',
  'src-tauri/resources/uniopc-engine-runtime/uniopc-engine-runtime.catalog.json',
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function regularRead(root, file) {
  const components = file.split('/')
  for (let count = 1; count <= components.length; count++) {
    const info = await lstat(join(root, ...components.slice(0, count)))
    if (info.isSymbolicLink() || (count === components.length ? !info.isFile() : !info.isDirectory())) throw new Error(`Runtime input must be regular, without symlinks: ${file}`)
  }
  return readFile(join(root, file), 'utf8')
}
export function moduleImports(source) {
  if (/\b(?:import|require|createRequire)\s*\(/.test(source)) throw new Error('Runtime dynamic dependency syntax requires an explicit cache policy update')
  // Ask Node's own module parser, without evaluating code or resolving packages.
  // Runtime modules contain generated-code strings that regex import scans would
  // mistake for real dependencies. This works before npm ci on Node 22.
  const parser = "import { SourceTextModule } from 'node:vm'; import { readFileSync } from 'node:fs'; console.log(JSON.stringify(new SourceTextModule(readFileSync(0, 'utf8')).dependencySpecifiers))"
  const result = execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', parser], { input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  return [...new Set(JSON.parse(result))].sort()
}

export function parserLockClosure(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('Runtime cache requires a package-lock v3 packages map')
  const packages = lock.packages
  const root = packages['']
  const rootSpec = root.dependencies?.['@babel/parser'] || root.devDependencies?.['@babel/parser']
  if (!rootSpec) throw new Error('Missing locked @babel/parser root dependency')
  function locate(from, name) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('Invalid runtime lock dependency name')
    let parent = from
    while (true) {
      // Node skips a redundant node_modules/node_modules search level.
      if (posix.basename(parent) !== 'node_modules') {
        const location = parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`
        if (Object.hasOwn(packages, location)) return location
      }
      if (!parent) break
      parent = posix.dirname(parent)
      if (parent === '.') parent = ''
    }
    throw new Error(`Unresolved runtime lock dependency: ${from || '<root>'} -> ${name}`)
  }
  const records = new Map()
  function visit(location) {
    if (records.has(location)) return
    const entry = packages[location]
    if (!entry || entry.link || !entry.version || !/^https:\/\//.test(entry.resolved || '') || !/^sha(?:256|384|512)-\S+$/.test(entry.integrity || '')) throw new Error(`Missing, linked or unresolved runtime lock package: ${location}`)
    const record = { location, version: entry.version, resolved: entry.resolved, integrity: entry.integrity, edges: [] }
    records.set(location, record)
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const name of Object.keys(entry[kind] || {}).sort()) {
      const target = locate(location, name)
      record.edges.push({ kind, name, spec: entry[kind][name], location: target })
      visit(target)
    }
  }
  const location = locate('scripts', '@babel/parser')
  visit(location)
  return { root: { name: '@babel/parser', spec: rootSpec, location }, packages: [...records.values()].sort((a, b) => a.location.localeCompare(b.location, 'en')) }
}
export async function runtimeProjection({ projectRoot = ROOT, platform = 'win32', arch = 'x64', readInput } = {}) {
  if (!/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch)) throw new Error('Invalid runtime platform/architecture')
  const read = readInput || (file => regularRead(projectRoot, file))
  const modules = []
  for (const file of RUNTIME_MODULES) {
    const source = await read(file)
    for (const dependency of moduleImports(source)) {
      if (dependency.startsWith('node:')) continue
      if (dependency.startsWith('./') && RUNTIME_MODULES.includes(posix.normalize(posix.join(posix.dirname(file), dependency)))) continue
      if (dependency === '@babel/parser') continue
      throw new Error(`Runtime import closure changed; update cache policy: ${file} -> ${dependency}`)
    }
    modules.push({ file, sha256: digest(source) })
  }
  const cargo = await read('src-tauri/Cargo.toml')
  const metadata = cargo.match(/^\[package\.metadata\.uniopc\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1]
  const openclaw = metadata?.match(/^openclaw-version\s*=\s*"([^"]+)"\s*$/m)?.[1]
  const node = (await read('scripts/verify-openclaw-release-contract.mjs')).match(/export const OPENCLAW_RELEASE_NODE_VERSION = '([^']+)'/)?.[1]
  if (!openclaw || !node) throw new Error('Missing runtime OpenClaw/Node pins')
  return { platform, arch, openclaw, node, recipe: RUNTIME_RECIPE, modules, dependencies: parserLockClosure(JSON.parse(await read('package-lock.json'))) }
}
export async function runtimeCacheKey(options = {}) {
  const projection = await runtimeProjection(options)
  // Bind executable policy/recipe code without dragging in caller workflows,
  // application source/version, signing configuration or unrelated dependencies.
  const policy = await regularRead(options.projectRoot || ROOT, 'scripts/windows-runtime-cache.mjs')
  const hash = digest(JSON.stringify({ schema: 2, policy: digest(policy), projection }))
  return `uniopc-runtime-v2-${projection.platform}-${projection.arch}-openclaw-${projection.openclaw}-node-${projection.node}-${hash}`
}
export async function legacySeedKey({ projectRoot = ROOT, readLegacyInput } = {}) {
  const current = await runtimeProjection({ projectRoot })
  let legacy
  try {
    const read = readLegacyInput || (file => {
      const mode = execFileSync('git', ['ls-tree', LEGACY_SEED_COMMIT, '--', file], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (!/^100(?:644|755) blob /.test(mode)) throw new Error('Seed input is missing or not a regular Git blob')
      return execFileSync('git', ['show', `${LEGACY_SEED_COMMIT}:${file}`], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    })
    legacy = await runtimeProjection({ readInput: read })
    const manifest = JSON.parse(await read('package.json'))
    if (manifest.scripts?.['build:openclaw-runtime'] !== 'node scripts/build-openclaw-runtime-bundle.mjs') return ''
    const warm = await read('.github/workflows/prepare-windows-runtime.yml')
    const flags = warm.match(/run: npm run build:openclaw-runtime -- ([^\r\n]+)/)?.[1]
    if (!flags) return ''
    legacy.recipe = ['scripts/build-openclaw-runtime-bundle.mjs', ...flags.trim().split(/\s+/)]
  } catch { return '' } // Missing historical objects/cache means a normal fresh build.
  return JSON.stringify(current) === JSON.stringify(legacy) ? LEGACY_SEED_KEY : ''
}
export async function verifyCachedRuntime({ projectRoot = ROOT, verifyContract = verifyReleaseContract, verifyBranding = verifyRuntimeDirectory } = {}) {
  const runtimeDirectory = join(projectRoot, 'src-tauri/resources/uniopc-engine-runtime')
  for (const file of RUNTIME_CACHE_PATHS) await regularReadCheck(projectRoot, file)
  await verifyContract({ platform: 'win32', arch: 'x64' }, { projectRoot, runtimeDirectory })
  await verifyBranding(runtimeDirectory)
}
async function regularReadCheck(root, file) {
  const parts = file.split('/')
  for (let count = 1; count <= parts.length; count++) {
    const info = await lstat(join(root, ...parts.slice(0, count)))
    if (info.isSymbolicLink() || (count === parts.length ? !info.isFile() : !info.isDirectory())) throw new Error('Runtime cache must contain regular files without symlinks')
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'key' || process.argv[2] === 'seed-key') {
      if (process.argv[2] === 'seed-key') {
        // Never expose a legacy fallback to candidate tag consumers.
        const { guardPublicRelease } = await import('./public-release-guard.mjs')
        guardPublicRelease('warm')
      }
      const key = process.argv[2] === 'key' ? await runtimeCacheKey() : await legacySeedKey()
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `key=${key}\n`)
      console.log(key || 'No compatible legacy seed; fresh build required')
    } else if (process.argv[2] === 'verify') await verifyCachedRuntime()
    else if (process.argv[2] === 'build') {
      const result = spawnSync(process.execPath, RUNTIME_RECIPE, { cwd: ROOT, env: process.env, stdio: 'inherit' })
      if (result.error || result.status !== 0) throw new Error('Windows runtime recipe failed')
    } else throw new Error('Use key, seed-key, verify or build')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
