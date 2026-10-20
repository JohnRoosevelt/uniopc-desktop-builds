#!/usr/bin/env node

import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, parse as parsePath, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { readDesktopReleaseVersion } from './prepare-desktop-updater-release.mjs'
import { auditPluginRelease, canonicalJson, snapshotRegularFile } from './audit-openclaw-plugin.mjs'
import { buildOpenclawRuntimeBundle, findMachOBinaries, runtimeArchiveName } from './build-openclaw-runtime-bundle.mjs'
import { prepareBundledPluginDependencies } from './prepare-bundled-plugin-dependencies.mjs'
import { verifyReleaseContract } from './verify-openclaw-release-contract.mjs'
import { verifyRuntimeDirectory as verifyRuntimeWhitelabel } from './verify-uniopc-whitelabel-runtime.mjs'

const DEFAULT_ENV_FILE = '.env.release'
const RUNTIME_CATALOG_FILE = 'uniopc-engine-runtime.catalog.json'
const RUNTIME_RESOURCE_DIRECTORY = resolve('src-tauri', 'resources', 'uniopc-engine-runtime')
const PRODUCTION_FRONTEND_BACKENDS = [
  { url: 'VITE_SUPABASE_URL', key: 'VITE_SUPABASE_ANON_KEY', ref: 'spb-bp1f48p09a51z42o' },
  { url: 'VITE_PLUGINS_SUPABASE_URL', key: 'VITE_PLUGINS_SUPABASE_ANON_KEY', ref: 'spb-bp159ozk3o51rv4v' },
]

export function validateProductionFrontendBackend(buildEnv = {}, prodModeEnv = {}) {
  const effectiveEnv = { ...prodModeEnv, ...buildEnv }
  for (const backend of PRODUCTION_FRONTEND_BACKENDS) {
    let url
    try { url = new URL(String(effectiveEnv[backend.url] || '')) } catch {
      throw new Error(`Missing or invalid production frontend setting: ${backend.url}`)
    }
    if (url.protocol !== 'https:' || url.hostname !== `${backend.ref}.supabase.opentrust.net` || url.pathname !== '/') {
      throw new Error(`${backend.url} must target the production Supabase project`)
    }
    const key = String(effectiveEnv[backend.key] || '').trim()
    if (!key) throw new Error(`Missing production frontend setting: ${backend.key}`)
    const segments = key.split('.')
    if (segments.length > 1) {
      try {
        const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString())
        if (claims.ref && claims.ref !== backend.ref) {
          throw new Error(`${backend.key} belongs to a different Supabase project`)
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue // Future publishable keys are opaque rather than JWTs.
        throw error
      }
    }
  }
  return true
}

function stripQuotes(value) {
  const trimmed = String(value || '').trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export async function loadEnvFile(filePath) {
  const contents = await readFile(filePath, 'utf8')
  const env = {}

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const separatorIndex = line.indexOf('=')
    if (separatorIndex === -1) continue

    const key = line.slice(0, separatorIndex).trim()
    const value = stripQuotes(line.slice(separatorIndex + 1))
    if (key) env[key] = value
  }

  return env
}

function requireValue(value, name) {
  if (!String(value || '').trim()) {
    throw new Error(`Missing required release environment: ${name}`)
  }
}

export function parseArgs(argv) {
  const args = {
    app: 'admin',
    envFile: resolve(DEFAULT_ENV_FILE),
    allowSkipNotarization: false,
    allowUnauditedPlugins: false,
    auditPlugins: false,
    notarizationMode: 'post-build',
    notaryRetries: 3,
    extraTauriArgs: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]

    if (arg === '--') {
      args.extraTauriArgs = argv.slice(index + 1)
      break
    }

    switch (arg) {
      case '--app':
        args.app = next
        index += 1
        break
      case '--env-file':
        args.envFile = resolve(next)
        index += 1
        break
      case '--private-key':
        args.privateKey = next
        index += 1
        break
      case '--private-key-path':
        args.privateKeyPath = resolve(next)
        index += 1
        break
      case '--allow-skip-notarization':
        args.allowSkipNotarization = true
        args.notarizationMode = 'skip'
        break
      case '--allow-unaudited-plugins':
        args.allowUnauditedPlugins = true
        break
      case '--audit-plugins':
        args.auditPlugins = true
        break
      case '--notarization-mode':
        args.notarizationMode = next
        index += 1
        break
      case '--tauri-notarize':
        args.notarizationMode = 'tauri'
        break
      case '--post-build-notarize':
        args.notarizationMode = 'post-build'
        break
      case '--target':
        args.target = next
        index += 1
        break
      case '--notary-retries':
        args.notaryRetries = Number.parseInt(next, 10)
        index += 1
        break
      case '--help':
        args.help = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return args
}

function hasAppStoreConnectNotarization(env) {
  return Boolean(env.APPLE_API_ISSUER && env.APPLE_API_KEY && env.APPLE_API_KEY_PATH)
}

function hasAppleIdNotarization(env) {
  return Boolean(env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID)
}

function notarizationMode(env) {
  if (hasAppStoreConnectNotarization(env)) return 'App Store Connect API key'
  if (hasAppleIdNotarization(env)) return 'Apple ID app-specific password'
  return null
}

function validateNotarizationMode(mode) {
  if (!['post-build', 'tauri', 'skip'].includes(mode)) {
    throw new Error(`Unsupported notarization mode: ${mode}`)
  }
}

function defaultPrivateKeyPath() {
  return resolve(homedir(), '.tauri/imai-updater-ci.key')
}

async function assertReadableFile(filePath, label) {
  try {
    await access(filePath)
  } catch {
    throw new Error(`${label} is not readable: ${filePath}`)
  }
}

async function readTauriSigningIdentity(app) {
  const configPath = 'src-tauri/tauri.conf.json'
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8'))
  return config?.bundle?.macOS?.signingIdentity
}

async function readTauriProductName() {
  const configPath = 'src-tauri/tauri.conf.json'
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8'))
  return String(config?.productName || 'Uniopc').trim() || 'Uniopc'
}

function withoutAppleNotarizationEnv(env, {
  stripCertificate = false,
  stripIdentity = false,
} = {}) {
  const next = { ...env }
  const keys = [
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'APPLE_API_KEY_PATH',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
  ]
  if (stripCertificate) {
    keys.push('APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD')
  }
  if (stripIdentity) {
    keys.push(...Object.keys(next).filter(key => key.startsWith('APPLE_')))
  }
  for (const key of keys) {
    delete next[key]
  }
  return next
}

export async function pluginAuditEnvironment(env) {
  const parent = String(env.TEMP || env.TMP || tmpdir())
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'uniopc-plugin-audit-env-'))
  const home = join(root, 'home')
  const next = {}
  for (const key of [
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'LANG',
    'LC_ALL',
    'TZ',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID',
    'UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE',
    'UNIOPC_PLUGIN_AUDIT_COMMIT',
    'UNIOPC_PLUGIN_AUDIT_TARGET',
    'UNIOPC_PLUGIN_AUDIT_RUN_ID',
    'UNIOPC_PLUGIN_AUDIT_CONSUMPTION_DIR',
  ]) {
    if (Object.hasOwn(env, key) && String(env[key] || '').trim()) next[key] = env[key]
  }
  const pathValue = env.PATH || env.Path
  if (String(pathValue || '').trim()) next.PATH = pathValue
  const parsedHome = parsePath(home)
  next.HOME = home
  next.USERPROFILE = home
  next.HOMEDRIVE = parsedHome.root.replace(/[\\/]$/, '')
  next.HOMEPATH = home.slice(next.HOMEDRIVE.length)
  next.TEMP = join(root, 'temp')
  next.TMP = next.TEMP
  next.TMPDIR = next.TEMP
  next.APPDATA = join(home, 'AppData', 'Roaming')
  next.LOCALAPPDATA = join(home, 'AppData', 'Local')
  next.XDG_CACHE_HOME = join(home, '.cache')
  next.XDG_CONFIG_HOME = join(home, '.config')
  next.XDG_DATA_HOME = join(home, '.local', 'share')
  next.UNIOPC_PLUGIN_AUDIT_HOME = join(root, 'engine-home')
  next.UNIOPC_PLUGIN_AUDIT_STATE_DIR = join(root, 'engine-state')
  next.UNIOPC_PLUGIN_AUDIT_CONFIG_PATH = join(root, 'engine-state', 'openclaw.json')
  next.UNIOPC_PLUGIN_AUDIT_CACHE_DIR = join(root, 'engine-cache')
  next.OPENCLAW_WORKSPACE_DIR = join(root, 'workspace')
  await Promise.all([
    home,
    next.TEMP,
    next.APPDATA,
    next.LOCALAPPDATA,
    next.XDG_CACHE_HOME,
    next.XDG_CONFIG_HOME,
    next.XDG_DATA_HOME,
    next.UNIOPC_PLUGIN_AUDIT_HOME,
    next.UNIOPC_PLUGIN_AUDIT_STATE_DIR,
    next.UNIOPC_PLUGIN_AUDIT_CACHE_DIR,
    next.OPENCLAW_WORKSPACE_DIR,
  ].map((directory) => mkdir(directory, { recursive: true })))
  return {
    env: next,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

export async function stageRuntimeResourceSnapshot(runtimeBundle, env = process.env, { platform = process.platform } = {}) {
  const archivePath = String(runtimeBundle?.archivePath || '').trim()
  const manifest = runtimeBundle?.manifest
  if (
    !archivePath
    || !manifest
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || !/^[0-9a-f]{64}$/.test(String(manifest.sha256 || ''))
    || !Number.isSafeInteger(manifest.sizeBytes)
    || manifest.sizeBytes <= 0
    || typeof manifest.archive !== 'string'
    || !manifest.archive.trim()
  ) throw new Error('Runtime bundle did not return a complete verified manifest.')

  // Tauri's Windows resource resolver mishandles an absolute source on a
  // different drive (for example C:\Users\... from a D:\a\... checkout).
  // Put the immutable snapshot under src-tauri/target and refer to it by a
  // path relative to src-tauri so Cargo and the bundler resolve the same file.
  const requestedParent = platform === 'win32'
    ? resolve('src-tauri', 'target')
    : String(env.TEMP || env.TMP || tmpdir())
  await mkdir(requestedParent, { recursive: true })
  // macOS /var is a symlink to /private/var. The snapshot verifier rejects
  // paths containing symlinks, so create the snapshot under the real path.
  const parent = await realpath(requestedParent)
  const root = await mkdtemp(join(parent, 'uniopc-runtime-resource-'))
  await chmod(root, 0o700).catch(() => {})
  try {
    const resourceDirectory = join(root, `openclaw-runtime-${manifest.sha256}`)
    const archiveSnapshot = await snapshotRegularFile(archivePath, {
      outputDirectory: resourceDirectory,
      maxBytes: 512 * 1024 * 1024,
    })
    if (archiveSnapshot.sha256 !== manifest.sha256 || archiveSnapshot.sizeBytes !== manifest.sizeBytes) {
      throw new Error('Runtime resource changed after release-contract verification.')
    }
    const snapshotManifest = {
      ...manifest,
      archive: basename(archiveSnapshot.path),
      sha256: archiveSnapshot.sha256,
      sizeBytes: archiveSnapshot.sizeBytes,
    }
    const catalogPath = join(resourceDirectory, 'uniopc-engine-runtime.catalog.json')
    const catalogBytes = `${canonicalJson({ artifacts: [snapshotManifest] })}\n`
    await writeFile(catalogPath, catalogBytes, { flag: 'wx', mode: 0o400 })
    // Tauri preserves resource file modes inside the .app. macOS xattr must be
    // able to clear extended attributes on those copied files before signing.
    // The snapshot is still verified by content hash before packaging.
    await Promise.all([
      chmod(archiveSnapshot.path, 0o644),
      chmod(catalogPath, 0o644),
    ])
    const tauriConfigPath = join(root, 'tauri-runtime-resource.json')
    const tauriConfig = {
      bundle: {
        resources: {
          'resources/uniopc-engine-runtime': null,
          [platform === 'win32'
            ? relative(resolve('src-tauri'), resourceDirectory).replace(/\\/g, '/')
            : resourceDirectory]: 'uniopc-engine-runtime',
        },
      },
    }
    const tauriConfigBytes = `${canonicalJson(tauriConfig)}\n`
    await writeFile(tauriConfigPath, tauriConfigBytes, { flag: 'wx', mode: 0o400 })
    return {
      root,
      archivePath: archiveSnapshot.path,
      manifest: snapshotManifest,
      resourceDirectory,
      catalogPath,
      tauriConfigPath,
      async verify() {
        if (!await archiveSnapshot.verify()) return false
        const [catalog, config, archiveStat, catalogStat] = await Promise.all([
          readFile(catalogPath, 'utf8').catch(() => null),
          readFile(tauriConfigPath, 'utf8').catch(() => null),
          stat(archiveSnapshot.path).catch(() => null),
          stat(catalogPath).catch(() => null),
        ])
        return catalog === catalogBytes
          && config === tauriConfigBytes
          && Boolean(archiveStat?.mode & 0o200)
          && Boolean(catalogStat?.mode & 0o200)
      },
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function preparedRuntimeManifest(catalog, target) {
  const expectedArchive = runtimeArchiveName(target.platform, target.arch)
  const artifacts = Array.isArray(catalog?.artifacts) ? catalog.artifacts : []
  if (artifacts.length !== 1) throw new Error('Prepared runtime catalog must contain exactly one target artifact.')
  const manifest = artifacts[0]
  if (
    !manifest
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || Object.keys(manifest).sort().join('\0') !== [
      'archive', 'arch', 'nodeVersion', 'platform', 'sha256', 'sizeBytes', 'version',
    ].sort().join('\0')
    || manifest.platform !== target.platform
    || manifest.arch !== target.arch
    || manifest.archive !== expectedArchive
    || !/^[0-9a-f]{64}$/.test(String(manifest.sha256 || ''))
    || !Number.isSafeInteger(manifest.sizeBytes)
    || manifest.sizeBytes <= 0
    || manifest.nodeVersion !== '24.19.0'
    || manifest.version !== '2026.8.1'
  ) throw new Error('Prepared runtime catalog does not match the requested release target.')
  return { ...manifest }
}

// A release job may consume only the native runtime bytes produced by its
// target-specific preparation job and carried in the audited artifact bundle.
// The artifact catalog is intentionally one-target-only: accepting a merged
// or rebuilt catalog here would make it possible to select bytes that the
// Linux audit did not attest. buildDesktopRelease verifies the copied catalog
// with verifyReleaseContract immediately after this function returns.
export async function installPreparedRuntimeBundle({
  sourceDirectory,
  target,
  outputDirectory = RUNTIME_RESOURCE_DIRECTORY,
} = {}) {
  const source = String(sourceDirectory || '').trim()
  if (!source || !target?.platform || !target?.arch) {
    throw new Error('Prepared runtime directory and target are required.')
  }
  const staging = await mkdtemp(join(await realpath(tmpdir()), 'uniopc-prepared-runtime-'))
  try {
    const catalogSnapshot = await snapshotRegularFile(join(source, RUNTIME_CATALOG_FILE), {
      outputDirectory: join(staging, 'catalog'),
      maxBytes: 1024 * 1024,
    })
    let catalog
    try {
      catalog = JSON.parse(await readFile(catalogSnapshot.path, 'utf8'))
    } catch {
      throw new Error('Prepared runtime catalog is invalid.')
    }
    const manifest = preparedRuntimeManifest(catalog, target)
    const archiveSnapshot = await snapshotRegularFile(join(source, manifest.archive), {
      outputDirectory: join(staging, 'archive'),
      maxBytes: 512 * 1024 * 1024,
    })
    if (archiveSnapshot.sha256 !== manifest.sha256 || archiveSnapshot.sizeBytes !== manifest.sizeBytes) {
      throw new Error('Prepared runtime archive does not match its catalog SHA-256.')
    }

    const destination = resolve(outputDirectory)
    await mkdir(destination, { recursive: true })
    await chmod(destination, 0o700).catch(() => {})
    const destinationArchive = join(destination, manifest.archive)
    // CI can stage in C: while checking out on D:. Copy into the destination
    // filesystem, verify the copied bytes, then replace the published archive.
    const incomingArchive = `${destinationArchive}.incoming-${process.pid}`
    try {
      await copyFile(archiveSnapshot.path, incomingArchive)
      const copiedHash = createHash('sha256')
      for await (const chunk of createReadStream(incomingArchive)) copiedHash.update(chunk)
      if (copiedHash.digest('hex') !== manifest.sha256) {
        throw new Error('Prepared runtime copy does not match its catalog SHA-256.')
      }
      await rm(destinationArchive, { force: true })
      await rename(incomingArchive, destinationArchive)
    } finally {
      await rm(incomingArchive, { force: true }).catch(() => {})
    }
    await chmod(destinationArchive, 0o400).catch(() => {})
    const destinationCatalog = join(destination, RUNTIME_CATALOG_FILE)
    await chmod(destinationCatalog, 0o600).catch(() => {})
    await writeFile(
      destinationCatalog,
      `${canonicalJson({ artifacts: [manifest] })}\n`,
      { mode: 0o400 },
    )
    await chmod(destinationCatalog, 0o400).catch(() => {})
    return { archivePath: destinationArchive, manifest, skipped: true }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

function targetTripleFromArgs(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--target' || arg === '-t') return args[index + 1] || ''
    if (arg.startsWith('--target=')) return arg.slice('--target='.length)
    if (arg.startsWith('-t=')) return arg.slice('-t='.length)
  }
  return ''
}

export function runtimeTargetFromTauriTarget(targetTriple = '', host = process) {
  const normalized = String(targetTriple || '').trim()
  if (normalized === 'universal-apple-darwin') {
    throw new Error(
      'Universal macOS bundles are incompatible with a single-architecture embedded OpenClaw runtime. Build arm64 and x64 separately.',
    )
  }
  const targets = {
    'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
    'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
    'x86_64-pc-windows-msvc': { platform: 'win32', arch: 'x64' },
    'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64' },
  }
  if (normalized) {
    const target = targets[normalized]
    if (!target) throw new Error(`Unsupported desktop release target: ${normalized}`)
    return target
  }

  const hostTarget = `${host.platform}/${host.arch}`
  const hostTargets = {
    'darwin/arm64': targets['aarch64-apple-darwin'],
    'darwin/x64': targets['x86_64-apple-darwin'],
    'win32/x64': targets['x86_64-pc-windows-msvc'],
    'linux/x64': targets['x86_64-unknown-linux-gnu'],
  }
  if (!hostTargets[hostTarget]) throw new Error(`Unsupported desktop release host: ${hostTarget}`)
  return hostTargets[hostTarget]
}

function bundleRootForTarget(targetTriple = '') {
  return targetTriple
    ? resolve('src-tauri', 'target', targetTriple, 'release', 'bundle')
    : resolve('src-tauri', 'target', 'release', 'bundle')
}

export async function clearStaleRuntimeResourceOutput(targetTriple = '', targetRoot = resolve('src-tauri', 'target')) {
  // tauri-build copies resources into the Cargo release directory before
  // bundling. An older build may have left read-only copies there, which
  // fs::copy cannot overwrite on the next run.
  const releaseRoot = targetTriple
    ? join(targetRoot, targetTriple, 'release')
    : join(targetRoot, 'release')
  await rm(join(releaseRoot, 'uniopc-engine-runtime'), { recursive: true, force: true })
}

async function listFilesRecursive(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(path))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

export async function findReleaseArtifacts({ targetTriple = '', version, productName = 'Uniopc' } = {}) {
  const bundleRoot = bundleRootForTarget(targetTriple)
  const files = await listFilesRecursive(bundleRoot)
  const macosRoot = join(bundleRoot, 'macos')
  const dmgRoot = join(bundleRoot, 'dmg')
  const appPath = join(macosRoot, `${productName}.app`)
  const updaterPath = join(macosRoot, `${productName}.app.tar.gz`)
  const signaturePath = `${updaterPath}.sig`
  const dmgFiles = files.filter(file => file.startsWith(dmgRoot) && file.endsWith('.dmg'))
  const dmgPath = dmgFiles.find(file => basename(file).includes(`_${version}_`)) || ''

  return {
    bundleRoot,
    appPath,
    updaterPath,
    signaturePath,
    dmgPath,
  }
}

async function assertReadablePath(filePath, label) {
  try {
    const fileStat = await stat(filePath)
    if (fileStat.size === 0 && !fileStat.isDirectory()) throw new Error('empty file')
  } catch (error) {
    throw new Error(`${label} is not readable: ${filePath}${error?.message ? ` (${error.message})` : ''}`)
  }
}

export function releaseSpawnTarget(command, args, { platform = process.platform, npmExecPath = process.env.npm_execpath } = {}) {
  if (command === 'npm' && platform === 'win32' && !npmExecPath) {
    throw new Error('npm_execpath is missing; cannot launch npm on Windows.')
  }
  return command === 'npm' && platform === 'win32'
    ? { command: process.execPath, args: [npmExecPath, ...args] }
    : { command, args }
}

async function runCommand(command, args, { env, cwd = process.cwd(), label, stdio = 'inherit' }, deps) {
  console.log(label)
  const target = releaseSpawnTarget(command, args, { npmExecPath: env?.npm_execpath || process.env.npm_execpath })
  const child = deps.spawn(target.command, target.args, {
    cwd,
    env,
    stdio,
  })

  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.on('exit', (code) => resolveExit(code ?? 1))
    child.on('error', rejectExit)
  })

  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`)
  }
}

async function runJsonCommand(command, args, { env, label }, deps) {
  console.log(label)
  const child = deps.spawn(command, args, { cwd: process.cwd(), env, stdio: ['inherit', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise(resolveExit => {
    child.on('exit', code => resolveExit(code ?? 1))
    child.on('error', () => resolveExit(1))
  })
  if (exitCode !== 0) {
    const error = new Error(`${label} failed with exit code ${exitCode}: ${stderr.trim()}`)
    error.nonRetryable = /HTTP status code: 403/.test(stderr)
    throw error
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`${label} returned no valid JSON status: ${stdout.slice(0, 300)}`)
  }
}

export async function signBundledPluginBinaries({
  root = resolve('src-tauri', 'resources', 'plugins'),
  identity,
  env = process.env,
  deps = { spawn },
} = {}) {
  if (!identity) throw new Error('Missing Developer ID identity for bundled plugin binaries.')
  const binaries = await findMachOBinaries(root)
  binaries.sort((a, b) => Number(!/\.(?:node|dylib)$/.test(a)) - Number(!/\.(?:node|dylib)$/.test(b)))
  console.log(`Signing ${binaries.length} bundled plugin Mach-O binaries with "${identity}"...`)
  for (const binary of binaries) {
    await runCommand('codesign', [
      '--force', '--options', 'runtime', '--timestamp', '--sign', identity, binary,
    ], { env, label: `Signing bundled plugin binary ${binary}` }, deps)
    await runCommand('codesign', ['--verify', '--strict', binary], {
      env, label: `Verifying bundled plugin binary ${binary}`,
    }, deps)
  }
  return binaries
}

async function runCommandWithRetry(command, args, options, deps, attempts = 1) {
  let lastError = null
  const maxAttempts = Math.max(1, attempts || 1)
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runCommand(command, args, {
        ...options,
        label: `${options.label}${maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : ''}`,
      }, deps)
      return
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts) break
      console.warn(`${error.message || error}; retrying...`)
      await (deps.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms))))(Math.min(attempt * 1000, 5000))
    }
  }
  throw lastError
}

function notarytoolArgsForEnv(env, artifactPath) {
  if (hasAppStoreConnectNotarization(env)) {
    return ['notarytool', 'submit', artifactPath, '--key', env.APPLE_API_KEY_PATH, '--key-id', env.APPLE_API_KEY, '--issuer', env.APPLE_API_ISSUER, '--wait']
  }
  if (hasAppleIdNotarization(env)) {
    return ['notarytool', 'submit', artifactPath, '--apple-id', env.APPLE_ID, '--password', env.APPLE_PASSWORD, '--team-id', env.APPLE_TEAM_ID, '--wait']
  }
  throw new Error('Missing Apple notarization credentials for post-build notarization.')
}

export async function submitNotarization({ filePath, env, retries = 1, deps = { spawn } }) {
  const attempts = Math.max(1, retries)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runJsonCommand(
        'xcrun',
        [...notarytoolArgsForEnv(env, filePath), '--output-format', 'json'],
        { env, label: `Notarizing ${filePath} (attempt ${attempt}/${attempts})` },
        deps,
      )
      if (result.status !== 'Accepted') {
        throw Object.assign(new Error(
          `Apple notarization ${result.status || 'unknown'} for submission ${result.id || 'unknown'}; inspect the notarytool log before publishing.`,
        ), { nonRetryable: true })
      }
      console.log(`Apple notarization Accepted: ${result.id}`)
      return result
    } catch (error) {
      if (error.nonRetryable || attempt === attempts) throw error
      console.warn(`${error.message}; retrying...`)
    }
  }
}

// Staple a notarization ticket onto an artifact. When the artifact was not
// submitted itself but is nested inside one that was (the .app inside a
// notarized .dmg), stapler fetches its ticket from Apple by cdhash — a few
// retries absorb any brief ticket-propagation lag on Apple's CDN.
export async function stapleArtifact({ filePath, env, retries = 0, deps }) {
  const args = ['stapler', 'staple', filePath]
  const opts = { env, label: `Stapling ${filePath}` }
  if (retries > 0) {
    await runCommandWithRetry('xcrun', args, opts, deps, retries)
  } else {
    await runCommand('xcrun', args, opts, deps)
  }
}

export async function recreateUpdaterArtifact({ appPath, updaterPath, signaturePath, env, deps }) {
  await rm(updaterPath, { force: true }).catch(() => {})
  await rm(signaturePath, { force: true }).catch(() => {})
  const archiveEnv = { ...env, COPYFILE_DISABLE: '1' }

  await runCommand(
    'tar',
    ['--no-xattrs', '--no-mac-metadata', '-czf', updaterPath, '-C', resolve(appPath, '..'), basename(appPath)],
    { env: archiveEnv, label: `Rebuilding updater archive for ${appPath}` },
    deps,
  )
  await runCommand(
    'npm',
    ['run', 'tauri', '--', 'signer', 'sign', updaterPath],
    { env, label: `Signing updater archive ${updaterPath}` },
    deps,
  )

  await assertReadablePath(updaterPath, 'rebuilt Tauri updater artifact')
  await assertReadablePath(signaturePath, 'rebuilt Tauri updater signature')
}

async function verifyApp(appPath, env, deps) {
  await runCommand('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { env, label: `Verifying code signature for ${appPath}` }, deps)
  await runCommand('spctl', ['-a', '-vvv', '-t', 'exec', appPath], { env, label: `Verifying Gatekeeper acceptance for ${appPath}` }, deps)
}

async function verifyDmg(dmgPath, env, deps) {
  await runCommand('spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmgPath], { env, label: `Verifying Gatekeeper acceptance for ${dmgPath}` }, deps)
}

export async function notarizeReleaseArtifacts({ env, targetTriple, retries = 3, deps = { spawn } } = {}) {
  const version = await readDesktopReleaseVersion()
  const productName = await readTauriProductName()
  const artifacts = await findReleaseArtifacts({ targetTriple, version, productName })

  await assertReadablePath(artifacts.appPath, 'macOS app bundle')
  await assertReadablePath(artifacts.updaterPath, 'Tauri updater artifact')
  await assertReadablePath(artifacts.signaturePath, 'Tauri updater signature')
  await assertReadablePath(artifacts.dmgPath, 'macOS DMG installer')

  // Single Apple round-trip: the DMG embeds the same .app, so notarizing the
  // DMG registers the app's cdhash with Apple too. We then staple BOTH the DMG
  // and the standalone .app (the latter's ticket is fetched by cdhash — no
  // second submission) and rebuild the updater tar.gz from the now-stapled app.
  // This halves notarization wall-clock vs. submitting the app zip and the DMG
  // as two separate notarizations.
  await submitNotarization({ filePath: artifacts.dmgPath, env, retries, deps })
  await stapleArtifact({ filePath: artifacts.dmgPath, env, retries, deps })
  await stapleArtifact({ filePath: artifacts.appPath, env, retries, deps })
  await verifyApp(artifacts.appPath, env, deps)
  await verifyDmg(artifacts.dmgPath, env, deps)
  await recreateUpdaterArtifact({
    appPath: artifacts.appPath,
    updaterPath: artifacts.updaterPath,
    signaturePath: artifacts.signaturePath,
    env,
    deps,
  })

  return artifacts
}

export async function buildDesktopRelease(options, deps = { spawn }) {
  // Injectable so unit tests never trigger the real (network) runtime staging.
  const ensureRuntimeBundle = deps.ensureRuntimeBundle || buildOpenclawRuntimeBundle
  const verifyRuntimeContract = deps.verifyRuntimeContract || verifyReleaseContract
  const verifyBranding = deps.verifyRuntimeWhitelabel || verifyRuntimeWhitelabel
  const auditPluginMatrix = deps.auditPlugins || auditPluginRelease
  const fileEnv = await loadEnvFile(options.envFile)
  const producerOnlyAuditKeys = [
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY_PATH',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY_PASSWORD',
  ]
  if (producerOnlyAuditKeys.some((key) => (
    String(fileEnv[key] || '').trim() || String(process.env[key] || '').trim()
  ))) {
    throw new Error('Audit private keys are producer-only and must not be provided to the desktop build.')
  }
  const env = {
    ...process.env,
    ...fileEnv,
  }
  const prodModeEnv = await loadEnvFile(resolve('.env.prod'))
  validateProductionFrontendBackend(env, prodModeEnv)
  for (const key of producerOnlyAuditKeys) delete env[key]

  const extraTauriArgs = [...(options.extraTauriArgs || [])]
  const delegatedTarget = targetTripleFromArgs(extraTauriArgs)
  if (options.target && delegatedTarget && options.target !== delegatedTarget) {
    throw new Error(`Conflicting release targets: ${options.target} and ${delegatedTarget}`)
  }
  const targetTriple = options.target || delegatedTarget
  if (options.target && !delegatedTarget) {
    extraTauriArgs.push('--target', options.target)
  }

  const npmArgs = ['run', 'tauri', '--', 'build']
  if (extraTauriArgs.length) {
    npmArgs.push(...extraTauriArgs)
  }
  const runtimeTarget = runtimeTargetFromTauriTarget(targetTriple)
  const isAppleTarget = runtimeTarget.platform === 'darwin'
  const mode = notarizationMode(env)
  validateNotarizationMode(options.notarizationMode)
  if (
    isAppleTarget
    && options.notarizationMode !== 'skip'
    && !mode
    && !options.allowSkipNotarization
  ) {
    throw new Error(
      [
        'Missing Apple notarization credentials.',
        'Set either APPLE_API_ISSUER + APPLE_API_KEY + APPLE_API_KEY_PATH,',
        'or APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID in .env.release.',
        'Pass --allow-skip-notarization only for local smoke builds.',
      ].join(' '),
    )
  }
  const expectedAuditTarget = `${runtimeTarget.platform}/${runtimeTarget.arch}`
  if (options.auditPlugins && options.allowUnauditedPlugins) {
    throw new Error('--audit-plugins conflicts with --allow-unaudited-plugins.')
  }
  if (options.allowUnauditedPlugins) {
    if (expectedAuditTarget !== 'darwin/arm64' || String(env.CI || '').toLowerCase() === 'true') {
      throw new Error('Unaudited plugin release is supported only for a local darwin/arm64 build.')
    }
    if (options.notarizationMode === 'skip') {
      throw new Error('Unaudited plugin release still requires Apple notarization.')
    }
  }
  if (options.auditPlugins &&
    String(env.UNIOPC_PLUGIN_AUDIT_TARGET || '').trim()
    && env.UNIOPC_PLUGIN_AUDIT_TARGET !== expectedAuditTarget
  ) throw new Error('Plugin audit target does not match the desktop release target.')
  // Ensure the bundled OpenClaw runtime archive matches the pinned version
  // before Tauri packs resources (first-launch offline install depends on it).
  // A development build may have cached an unsigned archive for this target.
  // A distributable macOS app must instead repack it after signing every
  // embedded Mach-O binary, otherwise Apple scans the stale archive and rejects
  // the final DMG during notarization.
  const preparedRuntimeDirectory = String(env.UNIOPC_PREPARED_OPENCLAW_RUNTIME_DIR || '').trim()
  const installRuntime = deps.installPreparedRuntimeBundle || installPreparedRuntimeBundle
  const runtimeBundle = preparedRuntimeDirectory
    ? await installRuntime({ sourceDirectory: preparedRuntimeDirectory, target: runtimeTarget })
    : await ensureRuntimeBundle({ ...runtimeTarget, force: true })
  await verifyRuntimeContract(runtimeTarget)
  if (!deps.verifyRuntimeContract) await verifyBranding(RUNTIME_RESOURCE_DIRECTORY)
  const snapshotRuntime = deps.stageRuntimeResourceSnapshot || stageRuntimeResourceSnapshot
  const runtimeSnapshot = await snapshotRuntime(runtimeBundle, env)
  try {
    if (!await runtimeSnapshot.verify()) throw new Error('OpenClaw runtime resource snapshot verification failed.')
    const auditReportPath = env.UNIOPC_PLUGIN_AUDIT_REPORT
      ? resolve(env.UNIOPC_PLUGIN_AUDIT_REPORT)
      : resolve('dist', 'release-artifacts', 'plugin-audit-report.json')
    if (!options.auditPlugins) {
      await mkdir(dirname(auditReportPath), { recursive: true })
      await writeFile(auditReportPath, `${JSON.stringify({
        schemaVersion: 1,
        ok: false,
        skipped: true,
        reason: options.allowUnauditedPlugins ? 'manual_unaudited_plugins' : 'plugin_release_owned',
        target: expectedAuditTarget,
      }, null, 2)}\n`)
      console.log(`Cloud plugin audit belongs to plugin publication; desktop build recorded its scope in ${auditReportPath}.`)
    } else {
      const auditContext = await pluginAuditEnvironment(env)
      let pluginAudit
      try {
        pluginAudit = await auditPluginMatrix({
          matrixPath: env.UNIOPC_PLUGIN_RELEASE_MATRIX,
          executionRuntimeArchivePath: String(env.UNIOPC_PLUGIN_AUDIT_EXECUTION_RUNTIME || '').trim(),
          packageRuntimeArchivePath: runtimeSnapshot.archivePath,
          packageTarget: expectedAuditTarget,
          reportPath: auditReportPath,
          env: auditContext.env,
        })
      } finally {
        await auditContext.cleanup()
      }
      if (!pluginAudit?.ok) {
        throw new Error('云端插件发布门禁未通过。')
      }
    }

    const privateKeyPath =
      options.privateKeyPath ||
      env.TAURI_SIGNING_PRIVATE_KEY_PATH ||
      (!env.TAURI_SIGNING_PRIVATE_KEY ? defaultPrivateKeyPath() : null)

    if (options.privateKey) {
      env.TAURI_SIGNING_PRIVATE_KEY = options.privateKey
    } else if (privateKeyPath) {
      await assertReadableFile(privateKeyPath, 'Tauri updater private key')
      env.TAURI_SIGNING_PRIVATE_KEY = await readFile(privateKeyPath, 'utf8')
      delete env.TAURI_SIGNING_PRIVATE_KEY_PATH
    }

    requireValue(
      env.TAURI_SIGNING_PRIVATE_KEY || env.TAURI_SIGNING_PRIVATE_KEY_PATH,
      'TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH',
    )
    if (!Object.prototype.hasOwnProperty.call(env, 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')) {
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
    }

    const signingIdentity = isAppleTarget
      ? env.APPLE_CODESIGN_IDENTITY || (await readTauriSigningIdentity(options.app))
      : null
    if (isAppleTarget) {
      requireValue(signingIdentity, 'APPLE_CODESIGN_IDENTITY or bundle.macOS.signingIdentity')
    }
    const tauriBuildEnv = isAppleTarget && options.notarizationMode === 'tauri'
      ? env
      : withoutAppleNotarizationEnv(env, {
        stripCertificate: !isAppleTarget || options.notarizationMode === 'skip',
        stripIdentity: !isAppleTarget,
      })

    await (deps.prepareBundledPlugins || prepareBundledPluginDependencies)()
    console.log(`Building ${options.app} desktop release...`)
    console.log(`Notarization: ${
      !isAppleTarget
        ? `not applicable to ${runtimeTarget.platform}/${runtimeTarget.arch}`
        : options.notarizationMode === 'post-build'
        ? `${mode} after Tauri bundling with retries`
        : options.notarizationMode === 'tauri'
          ? `${mode} inside Tauri bundling`
          : 'skipped for local smoke build'
    }`)
    console.log(`Updater private key: ${privateKeyPath ? 'file path' : 'environment value'}`)
    if (isAppleTarget) console.log(`Code signing identity: ${signingIdentity}`)

    if (!await runtimeSnapshot.verify()) throw new Error('OpenClaw runtime resource snapshot verification failed.')
    if (isAppleTarget && options.notarizationMode !== 'skip') {
      await (deps.signBundledPluginBinaries || signBundledPluginBinaries)({
        identity: signingIdentity,
        env: tauriBuildEnv,
        deps,
      })
    }
    npmArgs.push('--config', runtimeSnapshot.tauriConfigPath)
    await (deps.clearStaleRuntimeResourceOutput || clearStaleRuntimeResourceOutput)(targetTriple)
    await runCommand('npm', npmArgs, { env: tauriBuildEnv, label: 'Building Tauri app bundle...' }, deps)

    if (isAppleTarget && options.notarizationMode === 'post-build') {
      await (deps.notarizeReleaseArtifacts || notarizeReleaseArtifacts)({
        env,
        targetTriple,
        retries: options.notaryRetries,
        deps,
      })
    }
  } finally {
    await runtimeSnapshot.cleanup()
  }
}

function usage() {
  return `Usage:
  npm run build:release -- [options]

This is the only supported entry point for distributable desktop packages.
Direct \`tauri build\` and \`npm run tauri:build\` are development-only and do
not establish a release contract.

Required in .env.release:
  TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH

Required for notarization, choose one:
  APPLE_API_ISSUER + APPLE_API_KEY + APPLE_API_KEY_PATH
  APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID

Optional:
  --env-file .env.release
  --private-key-path /Users/you/.tauri/imai-updater-ci.key
  --notarization-mode post-build|tauri|skip
  --tauri-notarize
  --notary-retries 3
  --audit-plugins         explicitly audit a plugin compatibility matrix
  --allow-unaudited-plugins    legacy local darwin/arm64 option; no longer needed
  --allow-skip-notarization
  --target <target-triple>    build one architecture-correct desktop release
  -- --target aarch64-apple-darwin`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  await buildDesktopRelease(args)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error)
    console.error('')
    console.error(usage())
    process.exit(1)
  })
}
