#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extract as tarExtract } from 'tar'

import {
  canonicalJson,
  createForegroundGatewaySupervisor,
  defaultPrepareArtifact,
  runReleaseMatrix,
  stageImmutableArtifact,
} from '../audit-openclaw-plugin.mjs'

const INPUT_ROOT = '/audit-input'
const WORK_ROOT = '/audit-work'
const MAX_REPORT_BYTES = 1024 * 1024
const LOCKED_ARGUMENTS = Object.freeze({
  command: 'audit-release-matrix',
  matrix: '--matrix',
  runtime: '--runtime',
  work: '--work',
  protocol: '--protocol',
  protocolVersion: '--protocol-version',
  reportSchemaVersion: '--report-schema-version',
})

function pathInside(value, root, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || !isAbsolute(value)) return false
  const absolute = resolve(value)
  const rootPath = resolve(root)
  const relation = relative(rootPath, absolute)
  return (allowRoot && relation === '') || (relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

export function parseExactWorkerArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 13 || argv[0] !== LOCKED_ARGUMENTS.command) {
    throw new TypeError('worker arguments invalid')
  }
  const expected = [
    [LOCKED_ARGUMENTS.matrix, 'matrix'],
    [LOCKED_ARGUMENTS.runtime, 'runtime'],
    [LOCKED_ARGUMENTS.work, 'work'],
    [LOCKED_ARGUMENTS.protocol, 'protocol'],
    [LOCKED_ARGUMENTS.protocolVersion, 'protocolVersion'],
    [LOCKED_ARGUMENTS.reportSchemaVersion, 'reportSchemaVersion'],
  ]
  const options = {}
  for (let index = 0; index < expected.length; index += 1) {
    const [flag, key] = expected[index]
    const offset = 1 + (index * 2)
    if (argv[offset] !== flag || typeof argv[offset + 1] !== 'string' || !argv[offset + 1]) {
      throw new TypeError('worker arguments invalid')
    }
    options[key] = argv[offset + 1]
  }
  if (
    options.protocol !== 'uniopc-openclaw-plugin-audit'
    || options.protocolVersion !== '1'
    || options.reportSchemaVersion !== '1'
    || !pathInside(options.matrix, INPUT_ROOT)
    || !pathInside(options.runtime, INPUT_ROOT)
    || !pathInside(options.work, WORK_ROOT, { allowRoot: true })
  ) throw new TypeError('worker arguments invalid')
  return options
}

export function workerEnvironment(source = process.env) {
  return {
    PATH: String(source.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),
    HOME: `${WORK_ROOT}/home`,
  }
}

export function boundWorkerReport(report, maxBytes = MAX_REPORT_BYTES) {
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.schemaVersion !== 1 || typeof report.ok !== 'boolean') {
    throw new TypeError('worker report invalid')
  }
  const serialized = canonicalJson(report)
  if (Buffer.byteLength(serialized) > maxBytes) throw new RangeError('worker report exceeds maximum size')
  return report
}

async function sameUidProcessIds() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return null
  const uid = String(process.getuid())
  const entries = await readdir('/proc', { withFileTypes: true }).catch(() => null)
  if (!entries) return null
  const pids = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const status = await readFile(join('/proc', entry.name, 'status'), 'utf8').catch(() => '')
    const processUid = /^Uid:\s+(\d+)/m.exec(status)?.[1]
    if (processUid === uid) pids.push(Number(entry.name))
  }
  return pids
}

function pause(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function removeOwnedDescendants(baseline) {
  if (!baseline) return false
  const baselineIds = new Set(baseline)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const active = await sameUidProcessIds()
    if (!active) return false
    const descendants = active.filter((pid) => pid !== process.pid && !baselineIds.has(pid))
    if (descendants.length === 0) return true
    for (const pid of descendants) {
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        if (error?.code !== 'ESRCH') return false
      }
    }
    await pause(25)
  }
  const active = await sameUidProcessIds()
  return Boolean(active && active.every((pid) => pid === process.pid || baselineIds.has(pid)))
}

export function runOwnedCommand({ command, args, cwd, env }) {
  return new Promise((resolveResult) => {
    void sameUidProcessIds().then((baseline) => ({
      baseline,
      child: spawn(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    })).then(({ child, baseline }) => {
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => { stdout += chunk })
      child.stderr?.on('data', (chunk) => { stderr += chunk })
      child.on('error', () => resolveResult({ code: 1, stdout: '', stderr: '', cleaned: false }))
      child.on('exit', (code) => {
        void (async () => {
          try { process.kill(-child.pid, 'SIGKILL') } catch {}
          const cleaned = await removeOwnedDescendants(baseline)
          resolveResult({ code: code ?? 1, stdout, stderr, cleaned })
        })()
      })
    }).catch(() => resolveResult({ code: 1, stdout: '', stderr: '', cleaned: false }))
  })
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function expandLinuxRuntime(runtimeArchivePath, runtimeRoot) {
  const archive = await stat(runtimeArchivePath)
  if (!archive.isFile() || archive.size <= 0) throw new Error('runtime archive invalid')
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
  await tarExtract({ file: runtimeArchivePath, cwd: runtimeRoot, strict: true, preservePaths: false, noChmod: true })
  const nodeCandidates = [
    join(runtimeRoot, 'tools', 'node', 'bin', 'node'),
    join(runtimeRoot, 'tools', 'node-v24.19.0', 'bin', 'node'),
  ]
  const packageCandidates = [
    join(runtimeRoot, 'tools', 'node', 'node_modules', 'uniopc-engine'),
    join(runtimeRoot, 'tools', 'node', 'lib', 'node_modules', 'uniopc-engine'),
    join(runtimeRoot, 'tools', 'node-v24.19.0', 'lib', 'node_modules', 'uniopc-engine'),
  ]
  const nodePath = (await Promise.all(nodeCandidates.map(async (candidate) => (await exists(candidate)) ? candidate : null))).find(Boolean)
  const packageRoot = (await Promise.all(packageCandidates.map(async (candidate) => (await exists(join(candidate, 'package.json'))) ? candidate : null))).find(Boolean)
  if (!nodePath || !packageRoot) throw new Error('runtime archive invalid')
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (packageJson.version !== '2026.8.1') throw new Error('runtime version invalid')
  return { version: packageJson.version, nodePath, cliPath: join(packageRoot, 'uniopc-engine.mjs'), packageRoot }
}

function gatewayPort() {
  return 30000 + (randomBytes(2).readUInt16BE(0) % 20000)
}

function workerAuditEnvironment(env, workDirectory, runtime) {
  const home = join(workDirectory, 'home')
  const auditRoot = join(workDirectory, 'audit')
  const port = gatewayPort()
  return {
    PATH: `${dirname(runtime.nodePath)}:${env.PATH}`,
    HOME: home,
    TMPDIR: join(workDirectory, 'tmp'),
    UNIOPC_PLUGIN_AUDIT_HOME: home,
    UNIOPC_PLUGIN_AUDIT_STATE_DIR: join(auditRoot, 'state'),
    UNIOPC_PLUGIN_AUDIT_CONFIG_PATH: join(auditRoot, 'config.json'),
    UNIOPC_PLUGIN_AUDIT_GATEWAY_URL: `ws://127.0.0.1:${port}`,
    UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN: randomBytes(32).toString('hex'),
    OPENCLAW_WORKSPACE_DIR: join(auditRoot, 'workspace'),
  }
}

async function createLinuxSandbox({ runtime, env, deps = {} }) {
  const supervisor = (deps.createForegroundGatewaySupervisor || createForegroundGatewaySupervisor)({ runtime, env, deps: { runCommand: deps.runCommand || runOwnedCommand } })
  let closed = false
  let cleanupConfirmed = false
  async function stop() {
    if (closed) return { cleaned: cleanupConfirmed }
    closed = true
    cleanupConfirmed = await supervisor.stop()
    return { cleaned: cleanupConfirmed }
  }
  return {
    enforced: true,
    kind: 'linux-container',
    runCommand: deps.runCommand || runOwnedCommand,
    restartRuntime: () => supervisor.restart(),
    stageArtifact: (artifactPath) => (deps.stageArtifact || stageImmutableArtifact)(artifactPath, { env }),
    quiesce: () => supervisor.stop(),
    close: stop,
  }
}

export async function runWorkerLifecycle({ matrixPath, runtimeArchivePath, workDirectory, env, deps = {} }) {
  const inputRoot = deps.inputRoot || INPUT_ROOT
  const workRoot = deps.workRoot || WORK_ROOT
  if ((deps.platform || process.platform) !== 'linux') throw new Error('linux worker required')
  if (!pathInside(matrixPath, inputRoot) || !pathInside(runtimeArchivePath, inputRoot) || !pathInside(workDirectory, workRoot, { allowRoot: true })) {
    throw new Error('worker paths invalid')
  }
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'))
  const runtimeRoot = join(workDirectory, 'runtime')
  await rm(runtimeRoot, { recursive: true, force: true })
  let sandbox
  try {
    const runtime = await (deps.expandLinuxRuntime || expandLinuxRuntime)(runtimeArchivePath, runtimeRoot)
    const isolatedEnv = workerAuditEnvironment(env, workDirectory, runtime)
    await Promise.all(Object.values({
      home: isolatedEnv.HOME,
      tmp: isolatedEnv.TMPDIR,
      state: isolatedEnv.UNIOPC_PLUGIN_AUDIT_STATE_DIR,
      workspace: isolatedEnv.OPENCLAW_WORKSPACE_DIR,
    }).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))
    sandbox = await createLinuxSandbox({ runtime, env: isolatedEnv, deps })
    return await (deps.runReleaseMatrix || runReleaseMatrix)({
      matrix,
      baseDir: dirname(matrixPath),
      runtime,
      env: isolatedEnv,
      deps: { sandbox, prepareArtifact: deps.prepareArtifact || defaultPrepareArtifact },
    })
  } finally {
    await sandbox?.close?.().catch(() => {})
    await rm(runtimeRoot, { recursive: true, force: true })
  }
}

export async function runWorker(argv, deps = {}) {
  const options = parseExactWorkerArguments(argv)
  const lifecycle = deps.runWorkerLifecycle || runWorkerLifecycle
  const report = await lifecycle({
    matrixPath: options.matrix,
    runtimeArchivePath: options.runtime,
    workDirectory: options.work,
    env: workerEnvironment(deps.environment || process.env),
  })
  const stdout = deps.stdout || ((value) => process.stdout.write(value))
  stdout(`${canonicalJson(boundWorkerReport(report))}\n`)
  return report.ok ? 0 : 1
}

async function main() {
  try {
    process.exitCode = await runWorker(process.argv.slice(2))
  } catch {
    const report = { schemaVersion: 1, ok: false, errors: [], warnings: [] }
    process.stdout.write(`${canonicalJson(report)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
