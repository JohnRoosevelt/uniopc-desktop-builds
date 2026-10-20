import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as tarCreate } from 'tar'

import { expandLinuxRuntime, runOwnedCommand, runWorker, runWorkerLifecycle, workerEnvironment } from './entrypoint.mjs'

const lockedArgs = [
  'audit-release-matrix',
  '--matrix', '/audit-input/release.matrix.json',
  '--runtime', '/audit-input/openclaw-runtime-linux-x64.tar.gz',
  '--work', '/audit-work',
  '--protocol', 'uniopc-openclaw-plugin-audit',
  '--protocol-version', '1',
  '--report-schema-version', '1',
]

test('runWorker accepts only the locked command and emits one canonical report', async () => {
  const stdout = []
  const code = await runWorker(lockedArgs, {
    runWorkerLifecycle: async (options) => {
      assert.deepEqual(options, {
        matrixPath: '/audit-input/release.matrix.json',
        runtimeArchivePath: '/audit-input/openclaw-runtime-linux-x64.tar.gz',
        workDirectory: '/audit-work',
        env: { PATH: '/usr/bin', HOME: '/audit-work/home' },
      })
      return { schemaVersion: 1, ok: true, errors: [], warnings: [] }
    },
    environment: { PATH: '/usr/bin', HOME: '/root', HTTP_PROXY: 'http://proxy' },
    stdout: (value) => stdout.push(value),
  })

  assert.equal(code, 0)
  assert.equal(stdout.length, 1)
  assert.equal(stdout[0], '{"errors":[],"ok":true,"schemaVersion":1,"warnings":[]}\n')
})

test('runWorker rejects an extra, duplicate, or drifted argument', async () => {
  for (const argv of [
    [...lockedArgs, '--extra', 'nope'],
    [...lockedArgs, '--work', '/audit-work'],
    lockedArgs.map((value) => value === '1' ? '2' : value),
  ]) {
    await assert.rejects(runWorker(argv), /worker arguments invalid/)
  }
})

test('runWorker rejects paths outside the mounted input and work roots', async () => {
  const escapedMatrix = [...lockedArgs]
  escapedMatrix[2] = '/audit-input/../release.matrix.json'
  const escapedWork = [...lockedArgs]
  escapedWork[6] = '/tmp/audit-work'

  await assert.rejects(runWorker(escapedMatrix), /worker arguments invalid/)
  await assert.rejects(runWorker(escapedWork), /worker arguments invalid/)
})

test('workerEnvironment preserves only safe PATH and the worker HOME', () => {
  assert.deepEqual(workerEnvironment({
    PATH: '/usr/bin',
    HOME: '/root',
    SUPABASE_SERVICE_ROLE_KEY: 'secret',
    UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN: 'secret',
    HTTP_PROXY: 'http://proxy',
  }), { PATH: '/usr/bin', HOME: '/audit-work/home' })
})

test('runOwnedCommand removes a detached command descendant before reporting cleanup', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-worker-owned-command-'))
  const descendantPid = join(root, 'descendant.pid')
  try {
    const result = await runOwnedCommand({
      command: process.execPath,
      args: ['-e', [
        "const {spawn}=require('node:child_process')",
        `const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'})`,
        `require('node:fs').writeFileSync(${JSON.stringify(descendantPid)},String(child.pid))`,
        'child.unref()',
      ].join(';')],
      cwd: root,
      env: { PATH: process.env.PATH || '' },
    })
    assert.equal(result.code, 0)
    assert.equal(result.cleaned, true)
    const pid = Number(await (await import('node:fs/promises')).readFile(descendantPid, 'utf8'))
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally {
    const rawPid = await (await import('node:fs/promises')).readFile(descendantPid, 'utf8').catch(() => '')
    if (/^\d+$/.test(rawPid)) {
      try { process.kill(Number(rawPid), 'SIGKILL') } catch {}
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('runWorkerLifecycle propagates failed command cleanup into the lifecycle result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-worker-lifecycle-cleanup-'))
  const inputRoot = join(root, 'input')
  const workRoot = join(root, 'work')
  const matrixPath = join(inputRoot, 'release.matrix.json')
  const runtimeArchivePath = join(inputRoot, 'runtime.tar.gz')
  try {
    await mkdir(inputRoot, { recursive: true })
    await writeFile(matrixPath, '{}')
    await writeFile(runtimeArchivePath, 'fixture')
    const report = await runWorkerLifecycle({
      matrixPath,
      runtimeArchivePath,
      workDirectory: workRoot,
      env: { PATH: process.env.PATH || '' },
      deps: {
        inputRoot,
        workRoot,
        platform: 'linux',
        expandLinuxRuntime: async () => ({
          version: '2026.8.1', nodePath: process.execPath, cliPath: 'cli', packageRoot: root,
        }),
        createForegroundGatewaySupervisor: () => ({
          stop: async () => true,
          restart: async () => ({ ok: true }),
        }),
        runCommand: async () => ({ code: 0, stdout: '', stderr: '', cleaned: false }),
        runReleaseMatrix: async ({ deps }) => {
          const command = await deps.sandbox.runCommand({ command: 'ignored', args: [], cwd: root, env: {} })
          return { schemaVersion: 1, ok: command.cleaned !== false, errors: [], warnings: [] }
        },
      },
    })
    assert.equal(report.ok, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('expandLinuxRuntime discovers the immutable Linux archive layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-worker-runtime-'))
  const source = join(root, 'source')
  const archive = join(root, 'runtime.tar.gz')
  const output = join(root, 'output')
  await mkdir(join(source, 'tools', 'node', 'bin'), { recursive: true })
  await mkdir(join(source, 'tools', 'node', 'node_modules', 'openclaw'), { recursive: true })
  await writeFile(join(source, 'tools', 'node', 'bin', 'node'), '')
  await writeFile(join(source, 'tools', 'node', 'node_modules', 'openclaw', 'package.json'), '{"version":"2026.8.1"}')
  await tarCreate({ cwd: source, file: archive, gzip: true }, ['tools'])
  try {
    const runtime = await expandLinuxRuntime(archive, output)
    assert.deepEqual(runtime, {
      version: '2026.8.1',
      nodePath: join(output, 'tools', 'node', 'bin', 'node'),
      cliPath: join(output, 'tools', 'node', 'node_modules', 'openclaw', 'openclaw.mjs'),
      packageRoot: join(output, 'tools', 'node', 'node_modules', 'openclaw'),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
