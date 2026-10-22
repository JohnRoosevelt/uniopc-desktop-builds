#!/usr/bin/env node

// Builds the bundled OpenClaw runtime archive that ships inside the desktop app
// (Phase 1 of "点开即用": first launch extracts this archive locally instead of
// downloading the CLI + Node from openclaw.ai / nodejs.org / npm at runtime).
//
// What it does:
//   1. Reads the pinned openclaw version from src-tauri/Cargo.toml
//      ([package.metadata.uniopc] openclaw-version) — single source of truth.
//   2. Stages a throwaway install prefix for the build machine's platform:
//        - macOS/Linux: runs the official install-cli.sh (reproduces the real
//          ~/.openclaw runtime layout).
//        - Windows: drops a portable Node.js + `npm install openclaw` into the
//          prefix (install-cli.sh is bash-only), matching what the runtime
//          fallback openclaw_windows_runtime::provision produces at launch.
//   3. Normalizes any path-dependent artifacts so the archive is
//      prefix-relocatable (no absolute paths baked in):
//        - unix:    tools/node symlink → relative; bin/openclaw shim → dirname-based
//        - windows: guarantees tools/node/openclaw.cmd + bin/openclaw.cmd exist
//                   (the npm-prefix layout is already %~dp0-relative)
//   4. Packs bin/ + tools/ into
//      src-tauri/resources/uniopc-engine-runtime/uniopc-engine-runtime-<platform>-<arch>.tar.gz
//      plus a target-specific uniopc-engine-runtime.catalog.json entry.
//
// Only the runtime subtrees (bin/, tools/) are bundled. User state
// (openclaw.json, identity/, state/, extensions/, logs/) is never included.
//
// Arch note: the archive is per-platform AND per-arch — it bundles the build
// machine's own platform+arch (Node + native .node modules are not portable).
// Releases must include a matching archive; the app deliberately never falls
// back to an unverified network install at runtime.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rebrandManagedRuntimeScopes } from './uniopc-runtime-scopes.mjs'
import { rebrandEngineWrapperContract, rebrandPluginManifestPaths, rebrandCompiledRuntimePaths, rebrandRuntimeTree, retainRuntimeWorkspaceTemplates } from './uniopc-runtime-branding.mjs'
import { inspectWindowsNativeRequireSources, verifyRuntimeDirectory } from './verify-uniopc-whitelabel-runtime.mjs'

import { OPENCLAW_RELEASE_NODE_VERSION } from './verify-openclaw-release-contract.mjs'

// Installer policy is part of the pinned engine contract, not a rolling input.
const UNIX_INSTALLER_CONTRACT = Object.freeze({
  engineVersion: '2026.8.1',
  url: 'https://raw.githubusercontent.com/openclaw/openclaw/ea806575e6450e4d1efdfc72c19f04be982a1b9b/scripts/install-cli.sh',
  sha256: '66a719b8e3fffbac45763e267f37d49e87ee5d282a606e74f55b2721f1322f94',
})
const OUTPUT_DIR = resolve('src-tauri/resources/uniopc-engine-runtime')
const RUNTIME_CATALOG_FILE = 'uniopc-engine-runtime.catalog.json'
const SUPPORTED_RUNTIME_TARGETS = new Set([
  'darwin/arm64',
  'darwin/x64',
  'win32/x64',
  'linux/x64',
  'linux/arm64',
])

// Windows has no `install-cli.sh` (that installer is bash-only) and ships no
// prefix-relocatable archive. We reproduce, at BUILD time, exactly what the
// runtime fallback `openclaw_windows_runtime::provision` does at first launch:
// drop a portable Node.js next to an `npm install`ed `openclaw`, yielding the
// natural Windows npm-prefix layout (`tools/node/node.exe`,
// `tools/node/openclaw.cmd`, `tools/node/node_modules/openclaw/`) that the
// Windows branches of the Rust runtime loader already know how to resolve.
// Keep NODE_DIST_* in lockstep with the constants in
// src-tauri/src/services/openclaw_windows_runtime.rs.
// The Uniopc 8.1 release contract pins Node exactly across every bundled
// target. Keep this in lockstep with the Rust catalog
// verifier in openclaw_runtime_catalog.rs.
export const WINDOWS_NODE_DIST_VERSION = `v${OPENCLAW_RELEASE_NODE_VERSION}`
const NODE_DIST_VERSION = WINDOWS_NODE_DIST_VERSION
const NODE_DIST_ARCH = 'win-x64'
const nodeArchiveStem = () => `node-${NODE_DIST_VERSION}-${NODE_DIST_ARCH}`
const nodeArchiveUrl = () =>
  `https://nodejs.org/dist/${NODE_DIST_VERSION}/${nodeArchiveStem()}.zip`

// On Windows resolve tar to the system bsdtar (System32\tar.exe), never the
// bare `tar` on PATH: when this script runs under git-bash that resolves to GNU
// tar, which (a) can't read .zip and (b) parses `C:\...` as a remote host:path
// ("Cannot connect to C:"). bsdtar handles zip and treats C:\ paths as local.
function systemTarBin() {
  if (process.platform !== 'win32') return 'tar'
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return join(root, 'System32', 'tar.exe')
}

// What "the runtime" actually is — the self-contained environment that runs
// OpenClaw, NOT just Node. We pack two subtrees from the install prefix:
//   bin/   — the `openclaw` launch shim (the command entry point).
//   tools/ — node-vX.Y.Z/ : the Node.js engine itself (bin/node + npm + stdlib)
//            AND, under its lib/node_modules/openclaw/, OpenClaw itself — the
//            gateway / AI-employee / channel code, installed as an npm package.
// So Node is the engine and OpenClaw is the app that runs on it; the bundle is
// "engine + app" together. User data (openclaw.json, state/, identity/, logs/)
// is deliberately NOT included.
//
// This is why the archive is per-platform AND per-arch
// (uniopc-engine-runtime-<platform>-<arch>.tar.gz): the node binary and the native
// .node modules are platform/arch-specific (macOS Mach-O / Windows PE, arm64 vs
// x64). Only OpenClaw's own JS is portable. A given app can therefore only use
// the archive matching its own arch — e.g. an arm64 archive cannot run on an
// Intel Mac (Rosetta translates x86→arm, never arm→x86); that machine falls back
// to the network install path instead.
const RUNTIME_SUBTREES = ['bin', 'tools']

// Hardened-runtime entitlements the bundled Node needs (JIT, unsigned exec
// memory, and loading unsigned/native .node modules). Matches what Accio's
// notarized bundle uses on its node binary.
const RUNTIME_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
`

export async function readPinnedOpenclawVersion() {
  const toml = await readFile(resolve('src-tauri/Cargo.toml'), 'utf8')
  const match = toml.match(/^\s*openclaw-version\s*=\s*"([^"]+)"\s*$/m)
  if (!match) {
    throw new Error('openclaw-version not found under [package.metadata.uniopc] in src-tauri/Cargo.toml')
  }
  return match[1]
}

export function runtimeArchiveName(platform = process.platform, arch = process.arch) {
  return `uniopc-engine-runtime-${platform}-${arch}.tar.gz`
}

export function parseRuntimeBuildTarget(argv, defaults = { platform: process.platform, arch: process.arch }) {
  const target = { ...defaults }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--platform') {
      target.platform = argv[index + 1]
      index += 1
    } else if (argument === '--arch') {
      target.arch = argv[index + 1]
      index += 1
    }
  }
  if (!SUPPORTED_RUNTIME_TARGETS.has(`${target.platform}/${target.arch}`)) {
    throw new Error(`Unsupported runtime target: ${target.platform}/${target.arch}`)
  }
  return target
}

export function mergeRuntimeCatalog(current = { artifacts: [] }, artifact) {
  const retained = (current.artifacts || []).filter(
    entry => entry.platform !== artifact.platform || entry.arch !== artifact.arch,
  )
  return {
    artifacts: [...retained, artifact].sort((left, right) => (
      `${left.platform}/${left.arch}`.localeCompare(`${right.platform}/${right.arch}`)
    )),
  }
}

function runCommand(command, args, { env = process.env, cwd = process.cwd(), label } = {}) {
  if (label) console.log(label)
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.on('exit', (code) => {
      if (code === 0) resolveExit()
      else rejectExit(new Error(`${label || command} failed with exit code ${code}`))
    })
    child.on('error', rejectExit)
  })
}

// curl (not Node fetch): it follows HTTP(S)_PROXY, which release machines in CN
// networks rely on to reach nodejs.org / the install source. Windows 10+ ships
// curl.exe in System32, so this is portable across the platforms we build on.
async function downloadFile(url, destPath, { label } = {}) {
  await runCommand(
    'curl',
    ['-fsSL', '--proto', '=https', '--tlsv1.2', '-o', destPath, url],
    { label: label || `Downloading ${url}...` },
  )
  return destPath
}

async function downloadInstallScript(destPath, version) {
  if (version !== UNIX_INSTALLER_CONTRACT.engineVersion) {
    throw new Error(`No pinned Unix installer contract for OpenClaw ${version}`)
  }
  await downloadFile(UNIX_INSTALLER_CONTRACT.url, destPath)
  const body = await readFile(destPath)
  const digest = createHash('sha256').update(body).digest('hex')
  if (digest !== UNIX_INSTALLER_CONTRACT.sha256) {
    throw new Error('Downloaded Unix installer SHA-256 does not match the pinned contract')
  }
  if (!/^#!\/.*\b(?:bash|sh)\b/.test(body.toString('utf8')) || !body.includes('openclaw')) {
    throw new Error('Downloaded install script does not look like the OpenClaw shell installer')
  }
  return destPath
}

export async function stageOfficialInstall({ version, stagingRoot }) {
  const prefix = join(stagingRoot, 'openclaw-prefix')
  const scriptPath = join(stagingRoot, 'install-cli.sh')
  await downloadInstallScript(scriptPath, version)
  await runCommand(
    'bash',
    [
      scriptPath,
      '--json',
      '--no-onboard',
      '--prefix',
      prefix,
      '--version',
      version,
      '--node-version',
      OPENCLAW_RELEASE_NODE_VERSION,
    ],
    { label: `Staging official OpenClaw ${version} install into ${prefix}...` },
  )
  return prefix
}

// Windows staging: portable Node + `npm install openclaw` into a private prefix,
// mirroring src-tauri/src/services/openclaw_windows_runtime.rs but at build time.
async function stageWindowsInstall({ version, stagingRoot }) {
  const prefix = join(stagingRoot, 'openclaw-prefix')
  const nodeDir = join(prefix, 'tools', 'node')
  await mkdir(nodeDir, { recursive: true })

  // 1. Portable Node.js — extract with --strip-components=1 so the archive's
  //    single `node-<ver>-win-x64/` wrapper collapses straight into tools/node/.
  const zipPath = join(stagingRoot, `${nodeArchiveStem()}.zip`)
  await downloadFile(nodeArchiveUrl(), zipPath, { label: `Downloading ${nodeArchiveUrl()}...` })
  await runCommand(
    systemTarBin(),
    ['-xf', zipPath, '-C', nodeDir, '--strip-components=1'],
    { label: `Extracting Node.js into ${nodeDir}...` },
  )
  const nodeExe = join(nodeDir, 'node.exe')
  if (!(await pathExists(nodeExe))) {
    throw new Error(`Node.js extraction produced no node.exe at ${nodeExe}`)
  }

  // 2. `npm install --global --prefix <nodeDir> openclaw@<version>` using the
  //    just-extracted Node. Cache + userconfig live OUTSIDE the prefix so the
  //    packed archive never carries a developer's npm config or a download cache.
  const npmCli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!(await pathExists(npmCli))) {
    throw new Error(`Portable Node is missing npm at ${npmCli}`)
  }
  await runCommand(
    nodeExe,
    [
      npmCli,
      'install',
      '--global',
      '--prefix', nodeDir,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      `openclaw@${version}`,
    ],
    {
      cwd: nodeDir,
      env: {
        ...process.env,
        NPM_CONFIG_USERCONFIG: join(stagingRoot, '.npmrc-uniopc'),
        NPM_CONFIG_CACHE: join(stagingRoot, '.npm-cache'),
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        NO_UPDATE_NOTIFIER: '1',
        PATH: `${nodeDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
      },
      label: `Installing openclaw@${version} into ${nodeDir}...`,
    },
  )
  return prefix
}

async function pathExists(target) {
  return (await stat(target).catch(() => null)) !== null
}

async function findInstalledPackageJson(prefix) {
  const toolsDir = join(prefix, 'tools')
  const candidates = [
    // Windows npm --global --prefix layout: modules at the prefix root.
    join(toolsDir, 'node', 'node_modules', 'uniopc-engine', 'package.json'),
    join(toolsDir, 'node', 'node_modules', 'openclaw', 'package.json'),
  ]
  // Unix install-cli.sh layout: modules under node-vX.Y.Z/lib/node_modules.
  const entries = await readdir(toolsDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.name.startsWith('node')) continue
    candidates.push(join(toolsDir, entry.name, 'lib', 'node_modules', 'uniopc-engine', 'package.json'))
    candidates.push(join(toolsDir, entry.name, 'lib', 'node_modules', 'openclaw', 'package.json'))
  }
  for (const candidate of candidates) {
    try {
      return { path: candidate, json: JSON.parse(await readFile(candidate, 'utf8')) }
    } catch {
      // keep scanning: `node` may be the symlink alias of node-vX.Y.Z
    }
  }
  throw new Error(`Could not locate openclaw package.json under ${toolsDir}`)
}

// npm still identifies the upstream package as `openclaw` for plugin SDK
// exports and upstream dependency contracts. The installed filesystem entry
// and executable are Uniopc-owned and branded; preserve package.name as an
// internal resolution identity.
export async function renameInstalledEngine(prefix) {
  const toolsDir = join(prefix, 'tools')
  const oldRoots = [join(toolsDir, 'node', 'node_modules', 'openclaw')]
  for (const entry of await readdir(toolsDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('node')) {
      oldRoots.push(join(toolsDir, entry.name, 'lib', 'node_modules', 'openclaw'))
    }
  }
  let packageRoot = null
  for (const candidate of oldRoots) {
    if (await pathExists(join(candidate, 'package.json'))) { packageRoot = candidate; break }
  }
  if (!packageRoot) throw new Error(`Could not find staged upstream engine under ${toolsDir}`)
  const nextRoot = join(dirname(packageRoot), 'uniopc-engine')
  if (packageRoot !== nextRoot) await rename(packageRoot, nextRoot)
  await retainRuntimeWorkspaceTemplates(nextRoot)
  const manifestPath = join(nextRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const oldEntry = join(nextRoot, 'openclaw.mjs')
  const newEntry = join(nextRoot, 'uniopc-engine.mjs')
  if (await pathExists(oldEntry)) await rename(oldEntry, newEntry)
  // The compiled CLI only runs when its wrapper basename matches this table.
  // Renaming the launcher without updating it makes every CLI command exit 0
  // before starting the gateway, even though `--version` still succeeds.
  await rebrandEngineWrapperContract(nextRoot)
  if (manifest.bin) {
    manifest.bin = Object.fromEntries(Object.entries(manifest.bin).map(([name, entry]) => [
      name === 'openclaw' ? 'uniopc-engine' : name,
      entry === 'openclaw.mjs' ? 'uniopc-engine.mjs' : entry,
    ]))
  }
  if (manifest.exports?.['./cli-entry'] === './openclaw.mjs') manifest.exports['./cli-entry'] = './uniopc-engine.mjs'
  if (manifest.scripts?.start === 'node openclaw.mjs') manifest.scripts.start = 'node uniopc-engine.mjs'
  if (manifest.directories?.doc === 'docs') delete manifest.directories.doc
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`Renamed installed engine path and entry to ${nextRoot}`)
}

async function verifyStagedVersion(prefix, expectedVersion) {
  const { path, json } = await findInstalledPackageJson(prefix)
  if (json.version !== expectedVersion) {
    throw new Error(`Staged openclaw version mismatch: expected ${expectedVersion}, found ${json.version} at ${path}`)
  }
}

// The official installer writes two path-dependent artifacts. Rewrite both so
// the archive can be extracted under any prefix without a fixup pass in Rust.
async function normalizeStagedLayout(prefix) {
  // These upstream release notes are never used at runtime and expose the
  // upstream brand when users browse the installed resource directory.
  const { path: packageJsonPath } = await findInstalledPackageJson(prefix)
  const packageRoot = dirname(packageJsonPath)
  for (const name of ['README.md', 'CHANGELOG.md']) {
    await rm(join(packageRoot, name), { force: true })
  }

  // 1. tools/node absolute symlink → relative
  const nodeAlias = join(prefix, 'tools', 'node')
  // Remove npm's upstream-named secondary shim beside node; Uniopc invokes
  // the branded prefix launcher above, and no unbranded shim is required.
  for (const name of ['openclaw', 'openclaw.cmd', 'openclaw.ps1']) {
    await rm(join(nodeAlias, 'bin', name), { force: true })
  }
  for (const name of ['openclaw', 'openclaw.cmd', 'openclaw.ps1']) {
    await rm(join(nodeAlias, 'lib', 'node_modules', '.bin', name), { force: true })
  }
  const aliasStat = await lstat(nodeAlias).catch(() => null)
  if (aliasStat?.isSymbolicLink()) {
    const target = await readlink(nodeAlias)
    if (target.startsWith('/')) {
      const relativeTarget = relative(dirname(nodeAlias), target)
      await unlink(nodeAlias)
      await symlink(relativeTarget, nodeAlias)
      console.log(`Normalized tools/node symlink: ${target} → ${relativeTarget}`)
    }
  }

  // 2. bin/openclaw shim: hardcoded absolute prefix → dirname-based resolution
  const shimPath = join(prefix, 'bin', 'uniopc-engine')
  await rm(join(prefix, 'bin', 'openclaw'), { force: true })
  const portableShim = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'UNIOPC_PREFIX="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
    'exec "$UNIOPC_PREFIX/tools/node/bin/node" "$UNIOPC_PREFIX/tools/node/lib/node_modules/uniopc-engine/dist/entry.js" "$@"',
    '',
  ].join('\n')
  await writeFile(shimPath, portableShim, 'utf8')
  await chmod(shimPath, 0o755)
  console.log('Normalized bin/uniopc-engine shim to prefix-relative resolution')

  // 3. Guard: no other staged text file may still reference the staging prefix.
  const leftovers = []
  for (const binDir of [join(prefix, 'bin')]) {
    const entries = await readdir(binDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const filePath = join(binDir, entry.name)
      const contents = await readFile(filePath, 'utf8').catch(() => '')
      if (contents.includes(prefix)) leftovers.push(filePath)
    }
  }
  if (leftovers.length) {
    throw new Error(`Staged files still reference the staging prefix: ${leftovers.join(', ')}`)
  }
}

// Windows equivalent of normalizeStagedLayout. The npm-prefix layout is already
// relocatable (node.exe + node_modules resolve relative to the shim's %~dp0), so
// there is no absolute-path fixup to do — we only guarantee the two shims the
// runtime loader looks for and the bin/ subtree the extractor requires exist.
// Two openclaw 2026.6.11 Windows bugs break the secret-file ACL check, so the
// official-model token never loads on Windows. We patch the engine dist:
//
//  1. `icacls <file> /sid` — `/sid` is not a valid icacls parameter (the real
//     flag is `/findsid`), so the command always errors → the engine reports
//     `permission-unverified` ("ACL verification unavailable on Windows"). Drop
//     the bogus arg; plain `icacls <file>` returns name-form ACEs.
//
//  2. With name-form ACEs, the check must recognise the current user, but it
//     reads the user only from `opts.env` (undefined during secret resolution)
//     and falls back to os.userInfo() — which on Windows has NO domain, so a
//     local user's `MACHINE\user` ACE is classed untrusted → `permissions are
//     too open`. Fall back to `process.env` (which carries USERDOMAIN) so the
//     current user is trusted.
//
// Lenient by design: if a future engine already fixed either, that patch simply
// finds nothing and the build proceeds.
async function patchWindowsAclCheck(prefix) {
  const { path: packageJsonPath } = await findInstalledPackageJson(prefix)
  const distDir = join(dirname(packageJsonPath), 'dist')
  const entries = await readdir(distDir, { withFileTypes: true })
  let sidFixed = 0
  let envFixed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const filePath = join(distDir, entry.name)
    const original = await readFile(filePath, 'utf8').catch(() => null)
    if (original === null) continue
    let next = original
    // (1) Only the icacls inspection call passes [<path>, "/sid"]; the reset
    // builders use /inheritance:r + /grant:r, so this tuple match is specific.
    const afterSid = next.replace(/\[\s*([A-Za-z0-9_$]+)\s*,\s*"\/sid"\s*\]/g, '[$1]')
    if (afterSid !== next) sidFixed += 1
    next = afterSid
    // (2) effectiveEnv fallback to process.env for current-user recognition.
    const afterEnv = next.replace(/(effectiveEnv\s*=\s*opts\?\.env)(\s*;)/g, '$1 ?? process.env$2')
    if (afterEnv !== next) envFixed += 1
    next = afterEnv
    if (next !== original) await writeFile(filePath, next, 'utf8')
  }
  console.log(
    `Windows ACL fix: icacls /sid dropped in ${sidFixed} file(s), `
    + `env fallback added in ${envFixed} file(s)`,
  )
  if (sidFixed === 0 && envFixed === 0) {
    console.warn('Windows ACL fix: neither pattern found (engine may already be fixed).')
  }
}

// Runs only on the disposable unsigned Windows stage, never on an installed
// runtime or an archive restored from cache. Inspect every helper before writing.
export async function patchWindowsNativeModuleRequire(prefix) {
  const { path: packageJsonPath } = await findInstalledPackageJson(prefix)
  const sources = []
  const collect = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await collect(path)
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) sources.push({ path, source: await readFile(path, 'utf8') })
    }
  }
  await collect(join(dirname(packageJsonPath), 'dist'))
  const helpers = inspectWindowsNativeRequireSources(sources, { allowUnpatched: true })
  const changes = helpers.map(helper => ({...helper,
    next: helper.source.slice(0,helper.start)+helper.patchedBody+helper.source.slice(helper.end),
    temporary: helper.path+`.native-require-${process.pid}-${Date.now()}.tmp`,
  })).filter(change=>change.next!==change.source)
  // Every role, including the worker's VM checks, has passed before any write.
  // Prepare both replacements first, then publish each through an atomic rename.
  const published=[]
  try {
    for(const change of changes) await writeFile(change.temporary,change.next,'utf8')
    for(const change of changes) { await rename(change.temporary,change.path);published.push(change) }
  } catch(error) {
    for(const change of published) {
      await writeFile(change.temporary,change.source,'utf8')
      await rename(change.temporary,change.path)
    }
    throw error
  } finally {
    for(const change of changes) await rm(change.temporary,{force:true})
  }
}

async function normalizeWindowsLayout(prefix) {
  await patchWindowsAclCheck(prefix)
  const nodeDir = join(prefix, 'tools', 'node')

  // tools/node/openclaw.cmd is what runtime_shim_path() validates on Windows.
  // npm's global install writes it from the package `bin` field; only author a
  // fallback if it is somehow missing so we never clobber the generated shim.
  const toolShim = join(nodeDir, 'uniopc-engine.cmd')
  for (const name of ['openclaw', 'openclaw.cmd', 'openclaw.ps1']) {
    await rm(join(nodeDir, name), { force: true })
    await rm(join(nodeDir, 'node_modules', '.bin', name), { force: true })
  }
  if (!(await pathExists(toolShim))) {
    await writeFile(
      toolShim,
      '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\uniopc-engine\\uniopc-engine.mjs" %*\r\n',
      'utf8',
    )
    console.log('Authored fallback tools/node/uniopc-engine.cmd shim')
  }

  // bin/ must exist: the Rust extractor requires both bin/ and tools/ subtrees
  // (RUNTIME_SUBTREES). Ship a working prefix-root launcher parallel to the Unix
  // bin/openclaw shim.
  const binDir = join(prefix, 'bin')
  await mkdir(binDir, { recursive: true })
  await rm(join(binDir, 'openclaw.cmd'), { force: true })
  await writeFile(
    join(binDir, 'uniopc-engine.cmd'),
    '@echo off\r\n"%~dp0..\\tools\\node\\node.exe" "%~dp0..\\tools\\node\\node_modules\\uniopc-engine\\uniopc-engine.mjs" %*\r\n',
    'utf8',
  )
  console.log('Wrote bin/uniopc-engine.cmd launcher')

  // Trim any build-only clutter so the archive is engine + Node only, never a
  // download cache / npm logs. (Cache already lives outside the prefix; this is
  // belt-and-suspenders.)
  for (const junk of ['.npm-cache', '.npmrc-uniopc', '_logs']) {
    await rm(join(nodeDir, junk), { recursive: true, force: true }).catch(() => {})
  }
}

// White-label patch (L3): rewrite the standalone "OpenClaw" brand word to
// "Uniopc" across the whole engine dist, so the agent identifies as Uniopc in
// chat (its self-knowledge system prompts reference the brand dozens of times,
// not just an identity line). Correctness relies on three disjoint forms:
//   - `OpenClaw`  (mixed case)  → the brand word we replace
//   - `OPENCLAW_` (upper+under) → env var names, untouched (different case)
//   - `openclaw`  (lower)       → package name / URLs, untouched (different case)
// The word-boundary guard skips identifiers like `resolveOpenClawPackageRoot`
// (renaming those across minified chunks would risk breaking the runtime) and
// only rewrites the free-standing brand token in prose / display strings.
//
// Preserved on purpose: provider-attribution / analytics header VALUES
// (billing origin tags, never user-visible) keep the upstream brand.
const WHITELABEL_BRAND_WORD = /(?<![A-Za-z0-9_])OpenClaw(?![A-Za-z0-9_])/g
const WHITELABEL_MIN_TOTAL = 500
const WHITELABEL_PRESERVED = [
  // Restore attribution/source header values after the sweep.
  { from: 'OPENCLAW_ATTRIBUTION_PRODUCT = "Uniopc"', to: 'OPENCLAW_ATTRIBUTION_PRODUCT = "OpenClaw"' },
  { from: '"MM-API-Source": "Uniopc"', to: '"MM-API-Source": "OpenClaw"' },
  { from: '"MM-API-Source":"Uniopc"', to: '"MM-API-Source":"OpenClaw"' },
  { from: '"X-OpenRouter-Title": "Uniopc"', to: '"X-OpenRouter-Title": "OpenClaw"' },
  { from: '"X-OpenRouter-Title":"Uniopc"', to: '"X-OpenRouter-Title":"OpenClaw"' },
]

// A recovered upstream stream can leave one or more error placeholders at the
// front of an otherwise successful assistant answer. The stock prompt builder
// only drops a *pure* error turn, so those mixed replies are fed back into the
// next model call as if they were real assistant text. Strip every leading
// placeholder before constructing the next agent prompt.
const AGENT_PROMPT_ENTRY_SOURCE = 'function toPromptEntry(Ot){let Zt=safeBody(Ot.entry.body);return Ot.role===`assistant`&&Ot.internalStreamError===!0&&Zt.trim()===`[assistant turn failed before producing content]`?null:{...Ot.entry,body:Zt}}'
const AGENT_PROMPT_ENTRY_PATCHED_SOURCE = 'function toPromptEntry(Ot){let Zt=safeBody(Ot.entry.body),_n=Zt;for(;Ot.role===`assistant`&&_n.trimStart().startsWith(`[assistant turn failed before producing content]`);)_n=_n.trimStart().slice(`[assistant turn failed before producing content]`.length).trimStart();return Ot.role===`assistant`&&Ot.internalStreamError===!0&&_n.trim()===``?null:{...Ot.entry,body:_n}}'

export function scrubStreamFailureMarkersFromAgentPromptSource(source) {
  if (source.includes(AGENT_PROMPT_ENTRY_PATCHED_SOURCE)) return source
  if (!source.includes(AGENT_PROMPT_ENTRY_SOURCE)) {
    throw new Error('OpenClaw runtime drift: agent prompt fallback anchor was not found.')
  }
  return source.replace(AGENT_PROMPT_ENTRY_SOURCE, AGENT_PROMPT_ENTRY_PATCHED_SOURCE)
}

// OpenClaw 2026.8.1 serializes generated media previews (for example an audio
// narration) as assistant content blocks.  Those are valid transcript/UI
// artifacts, but its model-context transformer treats every non-text block as
// a tool call and invokes `block.id.trim()`.  Media blocks have no tool-call
// id, which prevents every later turn in that conversation from reaching the
// model.  Keep media in the stored transcript for rendering, but exclude any
// non-tool assistant block from the model-only replay.
const ASSISTANT_ATTACHMENT_TRANSFORM_SOURCE = 'if (block.type === "text") return sameModel ? block : {\n\t\t\ttype: "text",\n\t\t\ttext: block.text\n\t\t};\n\t\tconst { thoughtSignature: _, ...unsigned } = block;\n\t\tconst trimmedId = block.id.trim();'
const ASSISTANT_ATTACHMENT_TRANSFORM_PATCHED_SOURCE = 'if (block.type === "text") return sameModel ? block : {\n\t\t\ttype: "text",\n\t\t\ttext: block.text\n\t\t};\n\t\tif (block.type !== "toolCall") return [];\n\t\tconst { thoughtSignature: _, ...unsigned } = block;\n\t\tconst trimmedId = typeof block.id === "string" ? block.id.trim() : "";\n\t\tif (!trimmedId) return [];'

export function scrubAssistantAttachmentsFromModelContextSource(source) {
  if (source.includes(ASSISTANT_ATTACHMENT_TRANSFORM_PATCHED_SOURCE)) return source
  if (!source.includes(ASSISTANT_ATTACHMENT_TRANSFORM_SOURCE)) {
    throw new Error('OpenClaw runtime drift: assistant attachment transformer anchor was not found.')
  }
  return source.replace(ASSISTANT_ATTACHMENT_TRANSFORM_SOURCE, ASSISTANT_ATTACHMENT_TRANSFORM_PATCHED_SOURCE)
}

const CHAT_ATTACHMENT_SCHEMA_SOURCE = 'fileName: Type.Optional(Type.String()),\n\tcontent: Type.Optional(Type.Unknown()),'
const CHAT_ATTACHMENT_SCHEMA_PATCHED_SOURCE = 'fileName: Type.Optional(Type.String()),\n\tlocalMediaId: Type.Optional(Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" })),\n\tcontent: Type.Optional(Type.Unknown()),'
const RPC_ATTACHMENT_NORMALIZER_SOURCE = 'fileName: typeof a?.fileName === "string" ? a.fileName : void 0,\n\t\t\tcontent: normalizeAttachmentContent(a?.content) ?? sourceContent,'
const RPC_ATTACHMENT_NORMALIZER_PATCHED_SOURCE = 'fileName: typeof a?.fileName === "string" ? a.fileName : void 0,\n\t\t\tlocalMediaId: typeof a?.localMediaId === "string" ? a.localMediaId : void 0,\n\t\t\tcontent: normalizeAttachmentContent(a?.content) ?? sourceContent,'
const RPC_ATTACHMENT_FILTER_SOURCE = '}).filter((a) => a.content !== void 0) ?? [];'
const RPC_ATTACHMENT_FILTER_PATCHED_SOURCE = '}).filter((a) => a.content !== void 0 || a.localMediaId !== void 0) ?? [];'
const CHAT_ATTACHMENT_MEDIA_IMPORT_SOURCE = 'import { f as saveMediaBuffer, i as deleteMediaBuffer } from "./store-BSk4tp5H.js";'
const CHAT_ATTACHMENT_MEDIA_IMPORT_PATCHED_SOURCE = 'import { f as saveMediaBuffer, i as deleteMediaBuffer, u as readMediaBuffer } from "./store-BSk4tp5H.js";'
const CHAT_ATTACHMENT_PARSE_SOURCE = 'const { base64: b64, label, mime } = normalizeAttachment(att, idx, {'
const CHAT_ATTACHMENT_PARSE_PATCHED_SOURCE = `let localMedia = null;
			let attachmentInput = att;
			if (att.localMediaId !== void 0) {
				if (typeof att.localMediaId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(att.localMediaId)) throw new UnsupportedAttachmentError("invalid-local-media-ref", "attachment local media reference is invalid");
				if (typeof att.content === "string" && att.content.trim()) throw new UnsupportedAttachmentError("ambiguous-local-media-ref", "attachment cannot include both localMediaId and content");
				const declaredMime = normalizeMime(att.mimeType);
				const localMaxBytes = 10 * 1024 * 1024;
				localMedia = await readMediaBuffer(att.localMediaId, "inbound", localMaxBytes);
				attachmentInput = { ...att, content: localMedia.buffer.toString("base64") };
			}
			const { base64: b64, label, mime } = normalizeAttachment(attachmentInput, idx, {`
const CHAT_ATTACHMENT_PARSE_LEGACY_PATCHED_SOURCE = CHAT_ATTACHMENT_PARSE_PATCHED_SOURCE.replace('const localMaxBytes = 10 * 1024 * 1024;', 'const localMaxBytes = declaredMime === "video/mp4" ? 50 * 1024 * 1024 : declaredMime === "application/pdf" || declaredMime === "application/vnd.ms-powerpoint" || declaredMime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || declaredMime === "text/plain" ? 20 * 1024 * 1024 : Math.min(maxBytes, 10 * 1024 * 1024);')
const CHAT_ATTACHMENT_MAX_BYTES_SOURCE = 'if (sizeBytes > maxBytes) throw new Error(`attachment ${label}: exceeds size limit (${sizeBytes} > ${maxBytes} bytes)`);'
const CHAT_ATTACHMENT_MAX_BYTES_PATCHED_SOURCE = 'const attachmentMaxBytes = localMedia ? 10 * 1024 * 1024 : maxBytes;\n\t\t\tif (sizeBytes > attachmentMaxBytes) throw new Error(`attachment ${label}: exceeds size limit (${sizeBytes} > ${attachmentMaxBytes} bytes)`);'
const CHAT_ATTACHMENT_MAX_BYTES_LEGACY_PATCHED_SOURCE = CHAT_ATTACHMENT_MAX_BYTES_PATCHED_SOURCE.replace('localMedia ? 10 * 1024 * 1024 : maxBytes', 'localMedia ? (normalizeMime(mime) === "video/mp4" ? 50 * 1024 * 1024 : normalizeMime(mime) === "application/pdf" || normalizeMime(mime) === "application/vnd.ms-powerpoint" || normalizeMime(mime) === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || normalizeMime(mime) === "text/plain" ? 20 * 1024 * 1024 : Math.min(maxBytes, 10 * 1024 * 1024)) : maxBytes')
const CHAT_ATTACHMENT_IMAGE_MAX_BYTES_SOURCE = 'if (isImage && sizeBytes > 6291456) throw new Error(`attachment ${label}: image exceeds size limit (${sizeBytes} > ${MAX_IMAGE_BYTES} bytes)`);'
const CHAT_ATTACHMENT_IMAGE_MAX_BYTES_PATCHED_SOURCE = 'const imageMaxBytes = localMedia ? 10 * 1024 * 1024 : 6291456;\n\t\t\tif (isImage && sizeBytes > imageMaxBytes) throw new Error(`attachment ${label}: image exceeds size limit (${sizeBytes} > ${imageMaxBytes} bytes)`);'
const CHAT_ATTACHMENT_OFFLOAD_CONDITION_SOURCE = 'if (!(shouldForceImageOffload || !isImage || sizeBytes > OFFLOAD_THRESHOLD_BYTES)) {'
const CHAT_ATTACHMENT_OFFLOAD_CONDITION_PATCHED_SOURCE = 'if (!localMedia && !(shouldForceImageOffload || !isImage || sizeBytes > OFFLOAD_THRESHOLD_BYTES)) {'
const CHAT_ATTACHMENT_SAVE_SOURCE = 'savedMedia = assertSavedMedia(await saveMediaBuffer(buffer, finalMime, "inbound", maxBytes, ensureExtension(label, finalMime)), label);\n\t\t\t} catch (err) {'
const CHAT_ATTACHMENT_SAVE_PATCHED_SOURCE = 'savedMedia = localMedia ? { id: localMedia.id, path: localMedia.path, mediaRef: buildManagedInboundMediaRef(localMedia.id) } : assertSavedMedia(await saveMediaBuffer(buffer, finalMime, "inbound", attachmentMaxBytes, ensureExtension(label, finalMime)), label);\n\t\t\t\tif (!localMedia) savedMediaIds.push(savedMedia.id);\n\t\t\t} catch (err) {'
const CHAT_ATTACHMENT_SAVED_ID_SOURCE = '\n\t\t\tsavedMediaIds.push(savedMedia.id);\n\t\t\tconst mediaRef = savedMedia.mediaRef;'
const CHAT_ATTACHMENT_SAVED_ID_PATCHED_SOURCE = '\n\t\t\tconst mediaRef = savedMedia.mediaRef;'

function applySingleAnchorPatch(source, original, patched, driftMessage) {
  if (source.includes(patched)) return source
  if (!source.includes(original)) throw new Error(driftMessage)
  return source.replace(original, patched)
}

export function addLocalMediaIdToChatAttachmentSchema(source) {
  return applySingleAnchorPatch(source, CHAT_ATTACHMENT_SCHEMA_SOURCE, CHAT_ATTACHMENT_SCHEMA_PATCHED_SOURCE, 'OpenClaw runtime drift: chat attachment schema anchor was not found.')
}

export function preserveLocalMediaIdInRpcAttachmentNormalizer(source) {
  let next = applySingleAnchorPatch(source, RPC_ATTACHMENT_NORMALIZER_SOURCE, RPC_ATTACHMENT_NORMALIZER_PATCHED_SOURCE, 'OpenClaw runtime drift: RPC attachment normalizer anchor was not found.')
  next = applySingleAnchorPatch(next, RPC_ATTACHMENT_FILTER_SOURCE, RPC_ATTACHMENT_FILTER_PATCHED_SOURCE, 'OpenClaw runtime drift: RPC attachment filter anchor was not found.')
  return next
}

export function resolveTrustedLocalMediaInAttachmentParser(source) {
  let normalized = source.replace(CHAT_ATTACHMENT_PARSE_LEGACY_PATCHED_SOURCE, CHAT_ATTACHMENT_PARSE_PATCHED_SOURCE)
  normalized = normalized.replace(CHAT_ATTACHMENT_MAX_BYTES_LEGACY_PATCHED_SOURCE, CHAT_ATTACHMENT_MAX_BYTES_PATCHED_SOURCE)
  let next = applySingleAnchorPatch(normalized, CHAT_ATTACHMENT_MEDIA_IMPORT_SOURCE, CHAT_ATTACHMENT_MEDIA_IMPORT_PATCHED_SOURCE, 'OpenClaw runtime drift: managed media reader import anchor was not found.')
  next = applySingleAnchorPatch(next, CHAT_ATTACHMENT_PARSE_SOURCE, CHAT_ATTACHMENT_PARSE_PATCHED_SOURCE, 'OpenClaw runtime drift: attachment parser anchor was not found.')
  next = applySingleAnchorPatch(next, CHAT_ATTACHMENT_MAX_BYTES_SOURCE, CHAT_ATTACHMENT_MAX_BYTES_PATCHED_SOURCE, 'OpenClaw runtime drift: attachment size check anchor was not found.')
  next = applySingleAnchorPatch(next, CHAT_ATTACHMENT_IMAGE_MAX_BYTES_SOURCE, CHAT_ATTACHMENT_IMAGE_MAX_BYTES_PATCHED_SOURCE, 'OpenClaw runtime drift: image attachment size check anchor was not found.')
  next = applySingleAnchorPatch(next, CHAT_ATTACHMENT_OFFLOAD_CONDITION_SOURCE, CHAT_ATTACHMENT_OFFLOAD_CONDITION_PATCHED_SOURCE, 'OpenClaw runtime drift: attachment offload anchor was not found.')
  next = applySingleAnchorPatch(next, CHAT_ATTACHMENT_SAVE_SOURCE, CHAT_ATTACHMENT_SAVE_PATCHED_SOURCE, 'OpenClaw runtime drift: managed media save anchor was not found.')
  next = applySingleAnchorPatch(next, CHAT_ATTACHMENT_SAVED_ID_SOURCE, CHAT_ATTACHMENT_SAVED_ID_PATCHED_SOURCE, 'OpenClaw runtime drift: managed media cleanup anchor was not found.')
  return next
}

async function patchOpenclawLocalMediaAttachments(prefix) {
  const { path: packageJsonPath } = await findInstalledPackageJson(prefix)
  const distDir = join(dirname(packageJsonPath), 'dist')
  const entries = await readdir(distDir, { withFileTypes: true })
  const sources = new Map()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const filePath = join(distDir, entry.name)
    sources.set(filePath, await readFile(filePath, 'utf8'))
  }

  const patchFile = async (predicate, patcher, label) => {
    for (const [filePath, original] of sources) {
      if (!predicate(original)) continue
      const patched = patcher(original)
      if (patched !== original) {
        await writeFile(filePath, patched, 'utf8')
        sources.set(filePath, patched)
      }
      console.log(`Patched ${label}: ${filePath}`)
      return
    }
    throw new Error(`OpenClaw runtime drift: ${label} module was not found.`)
  }

  await patchFile(
    source => source.includes(CHAT_ATTACHMENT_SCHEMA_SOURCE) || source.includes(CHAT_ATTACHMENT_SCHEMA_PATCHED_SOURCE),
    addLocalMediaIdToChatAttachmentSchema,
    'trusted local media chat attachment schema',
  )
  await patchFile(
    source => source.includes(RPC_ATTACHMENT_NORMALIZER_SOURCE) || source.includes(RPC_ATTACHMENT_NORMALIZER_PATCHED_SOURCE),
    preserveLocalMediaIdInRpcAttachmentNormalizer,
    'trusted local media RPC attachment normalizer',
  )
  await patchFile(
    source => source.includes(CHAT_ATTACHMENT_PARSE_SOURCE) || source.includes(CHAT_ATTACHMENT_PARSE_PATCHED_SOURCE),
    resolveTrustedLocalMediaInAttachmentParser,
    'trusted local media attachment parser',
  )
}

async function patchAssistantAttachmentsInModelContext(prefix) {
  const { path: packageJsonPath } = await findInstalledPackageJson(prefix)
  const aiDistDir = join(dirname(packageJsonPath), 'node_modules', '@openclaw', 'ai', 'dist')
  const entries = await readdir(aiDistDir, { withFileTypes: true }).catch(() => null)
  if (entries === null) {
    throw new Error(`OpenClaw runtime drift: AI runtime dist was not found at ${aiDistDir}`)
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    const filePath = join(aiDistDir, entry.name)
    const original = await readFile(filePath, 'utf8')
    if (!original.includes(ASSISTANT_ATTACHMENT_TRANSFORM_SOURCE)
      && !original.includes(ASSISTANT_ATTACHMENT_TRANSFORM_PATCHED_SOURCE)) continue
    const patched = scrubAssistantAttachmentsFromModelContextSource(original)
    if (patched !== original) {
      await writeFile(filePath, patched, 'utf8')
      console.log(`Patched assistant media attachments in model context: ${filePath}`)
    }
    return
  }

  throw new Error('OpenClaw runtime drift: assistant attachment transformer was not found.')
}

async function patchAgentPromptStreamFailureMarkers(prefix) {
  const { path: packageJsonPath } = await findInstalledPackageJson(prefix)
  const workerPath = join(dirname(packageJsonPath), 'dist', 'worker', 'worker.mjs')
  const original = await readFile(workerPath, 'utf8').catch(() => null)
  if (original === null) {
    throw new Error(`OpenClaw runtime drift: agent worker not found at ${workerPath}`)
  }
  const patched = scrubStreamFailureMarkersFromAgentPromptSource(original)
  if (patched !== original) {
    await writeFile(workerPath, patched, 'utf8')
    console.log(`Patched repeated stream-failure markers in ${workerPath}`)
  }
}

// Prune patch: keep only the bundled engine skills the product needs; drop the
// rest. The engine's npm package carries ~50 stock skills under skills/. None
// are required by the engine itself (no dist chunk hard-references a skill
// directory — the gateway boots with an empty skills/ tree), so the keep-list
// is driven purely by product dependencies. Everything else (Apple/SaaS/smart-
// home integrations, third-party AI CLIs, ClawHub marketplace, content
// utilities) is dropped and will be redistributed on demand through our own
// skill catalog (uniopc--skills) once that channel is wired up. Installed
// machines are not touched: the pruned tree only reaches new installs/upgrades
// via this archive. Only skill DIRECTORIES are pruned — loose files at the
// skills/ root (e.g. pyproject.toml shared by skill scripts) ship unchanged.
const KEPT_BUNDLED_SKILLS = [
  'skill-creator', // durable skill authoring via skill_workshop; named by uniopc-shopify prompt.md
  'taskflow', // 任务面板 "多步骤流程" work type maps automationKind 'taskflow' (runtime wiring is P1)
  'taskflow-inbox-triage', // official TaskFlow example pattern
  'node-connect', // pairing diagnostics for our first-party iOS/Android direct-connect flow
  'healthcheck', // gateway/host security self-audit
  'tmux', // interactive-CLI driving; generic agent workhorse
  'mcporter', // MCP server management — the product exposes an MCP surface
]

async function pruneBundledSkills(prefix) {
  const { path: packageJsonPath } = await findInstalledPackageJson(prefix)
  const skillsDir = join(dirname(packageJsonPath), 'skills')
  if (!(await pathExists(skillsDir))) {
    throw new Error(`Bundled-skill prune drift — ${skillsDir} does not exist; upstream layout may have changed.`)
  }
  const keep = new Set(KEPT_BUNDLED_SKILLS)
  const entries = await readdir(skillsDir, { withFileTypes: true })
  const removed = []
  const found = new Set()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (keep.has(entry.name)) {
      found.add(entry.name)
      continue
    }
    await rm(join(skillsDir, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  // A keep-listed skill vanishing upstream would silently ship a runtime
  // missing a capability the product depends on — fail loudly instead.
  const missing = KEPT_BUNDLED_SKILLS.filter((n) => !found.has(n))
  if (missing.length) {
    throw new Error(
      'Bundled-skill prune drift — keep-listed skill(s) not found upstream: '
      + `${missing.join(', ')} (under ${skillsDir}); upstream may have renamed or dropped them.`,
    )
  }
  console.log(`Bundled-skill prune: kept ${found.size} (${KEPT_BUNDLED_SKILLS.join(', ')}), `
    + `removed ${removed.length} stock skill(s).`)
}

async function applyWhitelabelPatch(prefix) {
  // Resolve dist/ next to the installed package.json so this works for both the
  // Unix (lib/node_modules) and Windows (node_modules) install layouts.
  const { path: packageJsonPath } = await findInstalledPackageJson(prefix)
  const distDir = join(dirname(packageJsonPath), 'dist')
  const entries = []
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await collect(path)
      else if (entry.isFile() && /\.m?js$/i.test(entry.name)) entries.push({ path, name: entry.name })
    }
  }
  await collect(distDir)
  const entryScript = join(dirname(packageJsonPath), 'uniopc-engine.mjs')
  if (await pathExists(entryScript)) entries.push({ path: entryScript, name: 'uniopc-engine.mjs' })
  let total = 0
  let filesChanged = 0

  for (const entry of entries) {
    const filePath = entry.path
    const original = await readFile(filePath, 'utf8').catch(() => null)
    if (original === null) continue
    const matches = original.match(WHITELABEL_BRAND_WORD)
    if (!matches) continue
    let patched = original.replace(WHITELABEL_BRAND_WORD, 'Uniopc')
    for (const rule of WHITELABEL_PRESERVED) {
      patched = patched.split(rule.from).join(rule.to)
    }
    await writeFile(filePath, patched, 'utf8')
    total += matches.length
    filesChanged += 1
  }

  if (total < WHITELABEL_MIN_TOTAL) {
    throw new Error(
      `White-label patch drift — only ${total} brand-word replacements `
      + `(expected ≥ ${WHITELABEL_MIN_TOTAL}); upstream layout may have changed.`,
    )
  }
  const visibleFiles = await rebrandRuntimeTree(dirname(packageJsonPath))
  console.log(`Whitelabel visible HTML/metadata: ${visibleFiles.length} file(s).`)
  console.log(`Whitelabel: OpenClaw → Uniopc, ${total} 处 / ${filesChanged} 文件(归因头保留)`)
}

function runCommandCapture(command, args) {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('exit', (code) => resolveExit({ code: code ?? 1, stdout, stderr }))
    child.on('error', (err) => resolveExit({ code: 1, stdout, stderr: String(err) }))
  })
}

export function isMachOMagic(bytes) {
  if (bytes.length < 4) return false
  const magic = bytes.readUInt32BE(0)
  return magic === 0xfeedface
    || magic === 0xcefaedfe
    || magic === 0xfeedfacf
    || magic === 0xcffaedfe
    || magic === 0xcafebabe
    || magic === 0xbebafeca
}

async function isMachO(filePath) {
  const handle = await open(filePath, 'r').catch(() => null)
  if (!handle) return false
  try {
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return bytesRead === header.length && isMachOMagic(header)
  } finally {
    await handle.close()
  }
}

export async function findMachOBinaries(root) {
  const found = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        if (await isMachO(full)) found.push(full)
      }
    }
  }
  await walk(root)
  return found
}

function resolveSigningIdentity() {
  const fromEnv = process.env.APPLE_CODESIGN_IDENTITY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return null
}

export function runtimeSigningMode(environment = process.env, { allowUnsignedLocal = false } = {}) {
  if (!allowUnsignedLocal && environment.UNIOPC_RUNTIME_ALLOW_UNSIGNED_LOCAL !== '1') return 'required'
  return environment.CI ? 'rejected' : 'skip-local'
}

async function readTauriSigningIdentity() {
  try {
    const config = JSON.parse(await readFile(resolve('src-tauri/tauri.conf.json'), 'utf8'))
    const id = config?.bundle?.macOS?.signingIdentity
    return id && String(id).trim() ? String(id).trim() : null
  } catch {
    return null
  }
}

// Sign every Mach-O binary in the staged runtime with Developer ID + hardened
// runtime + secure timestamp, BEFORE packing the tar.gz. Apple's notary scans
// inside the bundled archive; unsigned native binaries (node, *.node, dylibs)
// fail notarization. Tauri later signs the .app shell but never descends into
// the opaque tar.gz, so these inner signatures survive to notarization.
async function signRuntimeBinaries(prefix, { staging, allowUnsignedLocal = false }) {
  const signingMode = runtimeSigningMode(process.env, { allowUnsignedLocal })
  if (signingMode === 'rejected') {
    throw new Error('UNIOPC_RUNTIME_ALLOW_UNSIGNED_LOCAL=1 is forbidden in CI builds.')
  }
  if (signingMode === 'skip-local') {
    console.warn('WARNING: skipping runtime signing for this explicit local-only build.')
    return
  }
  if (process.platform !== 'darwin') return
  if (process.env.UNIOPC_SKIP_RUNTIME_CODESIGN === '1') {
    console.warn('WARNING: skipping bundled runtime codesign for local development.')
    return
  }
  const identity = resolveSigningIdentity() || (await readTauriSigningIdentity())
  if (!identity) {
    console.warn('WARNING: no signing identity (APPLE_CODESIGN_IDENTITY / tauri signingIdentity); '
      + 'bundled binaries are UNSIGNED and the app will fail notarization. '
      + 'Fine for local dev builds only.')
    return
  }

  const binaries = await findMachOBinaries(prefix)
  if (binaries.length === 0) {
    console.warn('WARNING: no Mach-O binaries found in staged runtime to sign.')
    return
  }

  const entitlementsPath = join(staging, 'runtime-entitlements.plist')
  await writeFile(entitlementsPath, RUNTIME_ENTITLEMENTS, 'utf8')

  // Sign libraries/modules before the executables that load them.
  binaries.sort((a, b) => {
    const rank = (p) => (p.endsWith('.dylib') || p.endsWith('.node') ? 0 : 1)
    return rank(a) - rank(b)
  })

  console.log(`Signing ${binaries.length} bundled Mach-O binaries with "${identity}"...`)
  for (const binary of binaries) {
    const { code, stderr } = await runCommandCapture('codesign', [
      '--force',
      '--options', 'runtime',
      '--timestamp',
      '--entitlements', entitlementsPath,
      '--sign', identity,
      binary,
    ])
    if (code !== 0) {
      throw new Error(`codesign failed for ${binary}: ${stderr.trim()}`)
    }
    const verify = await runCommandCapture('codesign', ['--verify', '--strict', binary])
    if (verify.code !== 0) {
      throw new Error(`codesign verify failed for ${binary}: ${verify.stderr.trim()}`)
    }
  }
  await rm(entitlementsPath, { force: true })
  console.log(`Signed ${binaries.length} bundled binaries (hardened runtime + timestamp).`)
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

async function packRuntimeArchive({ prefix, outputDir, platform, arch }) {
  await mkdir(outputDir, { recursive: true })
  const archivePath = join(outputDir, runtimeArchiveName(platform, arch))
  await rm(archivePath, { force: true })
  // --no-xattrs / --no-mac-metadata strip Apple resource forks; they are bsdtar
  // flags the Windows-bundled tar may not accept, so apply them on macOS only.
  const macTarFlags = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : []
  await runCommand(
    systemTarBin(),
    [...macTarFlags, '-czf', archivePath, '-C', prefix, ...RUNTIME_SUBTREES],
    {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      label: `Packing runtime archive ${archivePath}...`,
    },
  )
  return archivePath
}

export async function readRuntimeCatalog(outputDir = OUTPUT_DIR) {
  try {
    const catalog = JSON.parse(await readFile(join(outputDir, RUNTIME_CATALOG_FILE), 'utf8'))
    return Array.isArray(catalog?.artifacts) ? catalog : { artifacts: [] }
  } catch {
    return { artifacts: [] }
  }
}

export function nodeVersionMatchesRelease(value) {
  return String(value || '').trim().replace(/^v/, '') === OPENCLAW_RELEASE_NODE_VERSION
}

async function stagedNodeVersion(prefix) {
  const candidates = [
    join(prefix, 'tools', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node'),
  ]
  const tools = join(prefix, 'tools')
  const entries = await readdir(tools, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('node')) {
      candidates.push(join(tools, entry.name, process.platform === 'win32' ? 'node.exe' : 'bin/node'))
    }
  }
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue
    const { code, stdout, stderr } = await runCommandCapture(candidate, ['--version'])
    if (code === 0 && nodeVersionMatchesRelease(stdout)) return stdout.trim().replace(/^v/, '')
    throw new Error(`Staged Node.js must be ${OPENCLAW_RELEASE_NODE_VERSION}; found ${stdout.trim() || stderr.trim() || 'unknown'}`)
  }
  throw new Error('Could not locate the staged Node.js executable')
}

export async function buildOpenclawRuntimeBundle({
  force = false,
  outputDir = OUTPUT_DIR,
  platform = process.platform,
  arch = process.arch,
  allowUnsignedLocal = false,
} = {}) {
  parseRuntimeBuildTarget(['--platform', platform, '--arch', arch])
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(`Runtime artifacts must be built natively; requested ${platform}/${arch}, builder is ${process.platform}/${process.arch}`)
  }
  const version = await readPinnedOpenclawVersion()
  const archiveName = runtimeArchiveName(platform, arch)

  const existingCatalog = await readRuntimeCatalog(outputDir)
  const existing = existingCatalog.artifacts.find(
    artifact => artifact.version === version && artifact.platform === platform && artifact.arch === arch,
  )
  if (!force && existing) {
    const archivePath = join(outputDir, archiveName)
    const archiveStat = await stat(archivePath).catch(() => null)
    if (archiveStat?.size === existing.sizeBytes && archiveStat.size > 0) {
      // Cached and --skip paths must prove the same actual loader structure.
      await verifyRuntimeDirectory(outputDir)
      console.log(`Runtime bundle already present for openclaw ${version} (${platform}-${arch}); skipping. Use --force to rebuild.`)
      return { archivePath, manifest: existing, skipped: true }
    }
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), 'uniopc-engine-runtime-stage-'))
  try {
    const prefix = platform === 'win32'
      ? await stageWindowsInstall({ version, stagingRoot })
      : await stageOfficialInstall({ version, stagingRoot })
    await verifyStagedVersion(prefix, version)
    await renameInstalledEngine(prefix)
    await pruneBundledSkills(prefix)
    await applyWhitelabelPatch(prefix)
    await patchAssistantAttachmentsInModelContext(prefix)
    await patchAgentPromptStreamFailureMarkers(prefix)
    await patchOpenclawLocalMediaAttachments(prefix)
    if (platform === 'win32') {
      await patchWindowsNativeModuleRequire(prefix)
      await normalizeWindowsLayout(prefix)
    } else {
      await normalizeStagedLayout(prefix)
    }
    const { path: packageJsonPath } = await findInstalledPackageJson(prefix)
    await rebrandPluginManifestPaths(dirname(packageJsonPath))
    await rebrandManagedRuntimeScopes(dirname(packageJsonPath))
    const renamedChunks = await rebrandCompiledRuntimePaths(dirname(packageJsonPath))
    console.log(`Whitelabel compiled chunks: ${renamedChunks.length} renamed.`)
    const nodeVersion = await stagedNodeVersion(prefix)
    // No-op off macOS (Windows PE binaries are not codesigned in this pass).
    await signRuntimeBinaries(prefix, { staging: stagingRoot, allowUnsignedLocal })

    const archivePath = await packRuntimeArchive({ prefix, outputDir, platform, arch })
    const archiveStat = await stat(archivePath)
    const manifest = {
      version,
      platform,
      arch,
      archive: archiveName,
      sha256: await sha256File(archivePath),
      sizeBytes: archiveStat.size,
      nodeVersion,
    }
    const catalog = mergeRuntimeCatalog(existingCatalog, manifest)
    await writeFile(join(outputDir, RUNTIME_CATALOG_FILE), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
    await verifyRuntimeDirectory(outputDir)

    const sizeMb = (archiveStat.size / (1024 * 1024)).toFixed(1)
    console.log(`Runtime bundle ready: ${archivePath} (${sizeMb} MB, openclaw ${version}, ${platform}-${arch})`)
    if (archiveStat.size > 200 * 1024 * 1024) {
      console.warn(`WARNING: runtime bundle exceeds 200 MB (${sizeMb} MB); check for accidental payload growth.`)
    }
    return { archivePath, manifest, skipped: false }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }
}

function parseArgs(argv) {
  const args = { force: false, allowUnsignedLocal: false, targetArgs: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--force') args.force = true
    else if (argument === '--unsigned-local') args.allowUnsignedLocal = true
    else if (argument === '--help') args.help = true
    else if (argument === '--platform' || argument === '--arch') {
      const value = argv[index + 1]
      if (!value) throw new Error(`Missing value for ${argument}`)
      args.targetArgs.push(argument, value)
      index += 1
    } else throw new Error(`Unknown option: ${argument}`)
  }
  args.target = parseRuntimeBuildTarget(args.targetArgs)
  return args
}

function usage() {
  return `Usage:
  node scripts/build-openclaw-runtime-bundle.mjs [--force] [--unsigned-local] [--platform <node-platform> --arch <node-arch>]

Reads the pinned openclaw version from src-tauri/Cargo.toml, stages an official
install, and packs a prefix-relocatable runtime archive into
src-tauri/resources/uniopc-engine-runtime/ for bundling into the desktop app.

--unsigned-local skips macOS runtime signing only for local development and is
rejected in CI.`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  await buildOpenclawRuntimeBundle({
    force: args.force,
    allowUnsignedLocal: args.allowUnsignedLocal,
    ...args.target,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error)
    console.error('')
    console.error(usage())
    process.exit(1)
  })
}
