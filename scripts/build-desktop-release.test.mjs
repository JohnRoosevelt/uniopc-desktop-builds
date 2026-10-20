import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  buildDesktopRelease,
  clearStaleRuntimeResourceOutput,
  installPreparedRuntimeBundle,
  parseArgs,
  releaseSpawnTarget,
  recreateUpdaterArtifact,
  runtimeTargetFromTauriTarget,
  signBundledPluginBinaries,
  stapleArtifact,
  submitNotarization,
  validateProductionFrontendBackend,
} from './build-desktop-release.mjs'

test('release builds reject development Supabase targets and accept production defaults', () => {
  const production = {
    VITE_SUPABASE_URL: 'https://spb-bp1f48p09a51z42o.supabase.opentrust.net',
    VITE_SUPABASE_ANON_KEY: 'production-core-key',
    VITE_PLUGINS_SUPABASE_URL: 'https://spb-bp159ozk3o51rv4v.supabase.opentrust.net',
    VITE_PLUGINS_SUPABASE_ANON_KEY: 'production-plugins-key',
  }
  assert.equal(validateProductionFrontendBackend({}, production), true)
  assert.throws(() => validateProductionFrontendBackend({
    ...production,
    VITE_SUPABASE_URL: 'https://spb-bp10i1915oj07495.supabase.opentrust.net',
  }), /must target the production Supabase project/)
  assert.throws(() => validateProductionFrontendBackend({
    ...production,
    VITE_PLUGINS_SUPABASE_URL: 'https://spb-bp1gvnmm7m9oat33.supabase.opentrust.net',
  }), /must target the production Supabase project/)
})

test('Windows release starts npm through Node without a shell', () => {
  const args = ['run', 'tauri', '--', 'build']
  assert.deepEqual(
    releaseSpawnTarget('npm', args, { platform: 'win32', npmExecPath: 'C:\\npm\\npm-cli.js' }),
    { command: process.execPath, args: ['C:\\npm\\npm-cli.js', ...args] },
  )
  assert.deepEqual(releaseSpawnTarget('npm', args, { platform: 'darwin' }), { command: 'npm', args })
})

function fakeRuntimeSnapshot(archivePath = '/tmp/runtime.tar.gz') {
  return {
    archivePath: `${archivePath}.snapshot`,
    tauriConfigPath: '/tmp/tauri-runtime-resource.json',
    verify: async () => true,
    cleanup: async () => {},
  }
}

test('stapler retries a lost network connection without resubmitting or rebuilding', async () => {
  const commands = []
  const delays = []
  await stapleArtifact({ filePath: '/tmp/installer.dmg', env: {}, retries: 3, deps: {
    sleep: async ms => { delays.push(ms) },
    spawn: (command, args) => {
      commands.push({ command, args })
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', commands.length === 1 ? 68 : 0))
      return child
    },
  } })
  assert.equal(commands.length, 2)
  assert.ok(commands.every(c => c.command === 'xcrun' && c.args.join(' ') === 'stapler staple /tmp/installer.dmg'))
  assert.deepEqual(delays, [1000])
})

test('stapler stops after the configured attempts and preserves failure', async () => {
  let attempts = 0
  await assert.rejects(stapleArtifact({ filePath: '/tmp/installer.dmg', env: {}, retries: 3, deps: {
    sleep: async () => {},
    spawn: () => {
      attempts += 1
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', 68))
      return child
    },
  } }), /exit code 68/)
  assert.equal(attempts, 3)
})

test('build release defaults to retryable post-build notarization', () => {
  const args = parseArgs([])

  assert.equal(args.notarizationMode, 'post-build')
  assert.equal(args.notaryRetries, 3)
  assert.equal(args.auditPlugins, false)
})

test('plugin compatibility audit requires an explicit release option', () => {
  assert.equal(parseArgs(['--audit-plugins']).auditPlugins, true)
})

test('build release keeps explicit Tauri and skip notarization modes', () => {
  assert.equal(parseArgs(['--tauri-notarize']).notarizationMode, 'tauri')
  assert.equal(parseArgs(['--notarization-mode', 'tauri']).notarizationMode, 'tauri')

  const skipArgs = parseArgs(['--allow-skip-notarization'])
  assert.equal(skipArgs.allowSkipNotarization, true)
  assert.equal(skipArgs.notarizationMode, 'skip')
})

test('build release parses notary retry count and target args', () => {
  const args = parseArgs(['--notary-retries', '5', '--', '--target', 'aarch64-apple-darwin'])

  assert.equal(args.notaryRetries, 5)
  assert.deepEqual(args.extraTauriArgs, ['--target', 'aarch64-apple-darwin'])
})

test('build release parses a target before delegated Tauri arguments', () => {
  assert.equal(parseArgs(['--target', 'aarch64-apple-darwin']).target, 'aarch64-apple-darwin')
})

test('manual unaudited plugin flag keeps notarization enabled', () => {
  const args = parseArgs(['--allow-unaudited-plugins', '--target', 'aarch64-apple-darwin'])
  assert.equal(args.allowUnauditedPlugins, true)
  assert.equal(args.notarizationMode, 'post-build')
})

test('derives an embedded runtime target from the Tauri target triple', () => {
  assert.deepEqual(runtimeTargetFromTauriTarget('aarch64-apple-darwin'), { platform: 'darwin', arch: 'arm64' })
  assert.deepEqual(runtimeTargetFromTauriTarget('x86_64-apple-darwin'), { platform: 'darwin', arch: 'x64' })
  assert.deepEqual(runtimeTargetFromTauriTarget('x86_64-pc-windows-msvc'), { platform: 'win32', arch: 'x64' })
  assert.deepEqual(runtimeTargetFromTauriTarget('x86_64-unknown-linux-gnu'), { platform: 'linux', arch: 'x64' })
})

test('rejects universal macOS target for an embedded single-architecture runtime', () => {
  assert.throws(
    () => runtimeTargetFromTauriTarget('universal-apple-darwin'),
    /Universal macOS bundles are incompatible/,
  )
})

test('runtime resource snapshot is content-addressed and is the Tauri resource source', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uniopc-runtime-resource-snapshot-')))
  const archivePath = join(root, 'runtime.tar.gz')
  await writeFile(archivePath, 'trusted runtime')
  const manifest = {
    version: '2026.8.1',
    platform: 'linux',
    arch: 'x64',
    archive: 'runtime.tar.gz',
    sha256: createHash('sha256').update('trusted runtime').digest('hex'),
    sizeBytes: Buffer.byteLength('trusted runtime'),
    nodeVersion: '24.19.0',
  }
  const { stageRuntimeResourceSnapshot } = await import('./build-desktop-release.mjs')
  const snapshot = await stageRuntimeResourceSnapshot({ archivePath, manifest }, { TEMP: root, TMP: root })
  await writeFile(archivePath, 'replaced runtime')
  assert.equal(await readFile(snapshot.archivePath, 'utf8'), 'trusted runtime')
  assert.equal(snapshot.archivePath.includes(manifest.sha256), true)
  const override = JSON.parse(await readFile(snapshot.tauriConfigPath, 'utf8'))
  assert.equal(override.bundle.resources['resources/uniopc-engine-runtime'], null)
  assert.equal(override.bundle.resources[snapshot.resourceDirectory], 'uniopc-engine-runtime')
  assert.equal((await stat(snapshot.archivePath)).mode & 0o777, 0o644)
  assert.equal((await stat(snapshot.catalogPath)).mode & 0o777, 0o644)
  assert.equal(await snapshot.verify(), true)
  await chmod(snapshot.catalogPath, 0o400)
  assert.equal(await snapshot.verify(), false)
  await chmod(snapshot.catalogPath, 0o644)
  assert.equal(await snapshot.verify(), true)
  await writeFile(snapshot.catalogPath, 'changed after snapshot')
  assert.equal(await snapshot.verify(), false)
  await snapshot.cleanup()
})

test('Windows runtime resource uses a source path relative to src-tauri', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uniopc-win-runtime-resource-')))
  const archivePath = join(root, 'runtime.tar.gz')
  const bytes = Buffer.from('windows runtime')
  await writeFile(archivePath, bytes)
  const manifest = {
    version: '2026.8.1',
    platform: 'win32',
    arch: 'x64',
    archive: 'runtime.tar.gz',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    nodeVersion: '24.19.0',
  }
  const { stageRuntimeResourceSnapshot } = await import('./build-desktop-release.mjs')
  const snapshot = await stageRuntimeResourceSnapshot({ archivePath, manifest }, { TEMP: root }, { platform: 'win32' })
  try {
    const override = JSON.parse(await readFile(snapshot.tauriConfigPath, 'utf8'))
    const source = Object.keys(override.bundle.resources).find(key => key !== 'resources/uniopc-engine-runtime')
    assert.match(source, /^target\/uniopc-runtime-resource-/)
    assert.equal(resolve('src-tauri', source), snapshot.resourceDirectory)
    assert.equal(await snapshot.verify(), true)
  } finally {
    await snapshot.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('clears stale read-only Cargo resource copies before a rebuild', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'uniopc-cargo-target-'))
  const triple = 'aarch64-apple-darwin'
  const resourceRoot = join(targetRoot, triple, 'release', 'uniopc-engine-runtime')
  await mkdir(resourceRoot, { recursive: true })
  const staleCatalog = join(resourceRoot, 'uniopc-engine-runtime.catalog.json')
  await writeFile(staleCatalog, 'old catalog')
  await chmod(staleCatalog, 0o400)
  try {
    await clearStaleRuntimeResourceOutput(triple, targetRoot)
    await assert.rejects(stat(resourceRoot), { code: 'ENOENT' })
    await mkdir(resourceRoot)
    await writeFile(staleCatalog, 'new catalog')
    assert.equal(await readFile(staleCatalog, 'utf8'), 'new catalog')
  } finally {
    await rm(targetRoot, { recursive: true, force: true })
  }
})

test('signs bundled plugin Mach-O files before Tauri copies them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-signing-'))
  const binary = join(root, 'native.node')
  const source = join(root, 'index.js')
  await writeFile(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  await writeFile(source, 'export default true')
  const calls = []
  try {
    const binaries = await signBundledPluginBinaries({
      root,
      identity: 'Developer ID Application: Example (TEAM123)',
      deps: {
        spawn: (command, args) => {
          calls.push({ command, args })
          const child = new EventEmitter()
          queueMicrotask(() => child.emit('exit', 0))
          return child
        },
      },
    })
    assert.deepEqual(binaries, [binary])
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].args, [
      '--force', '--options', 'runtime', '--timestamp', '--sign',
      'Developer ID Application: Example (TEAM123)', binary,
    ])
    assert.deepEqual(calls[1].args, ['--verify', '--strict', binary])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stops on an Invalid Apple notarization result before stapling', async () => {
  let calls = 0
  const deps = {
    spawn: () => {
      calls += 1
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ id: 'submission-1', status: 'Invalid' }))
        child.emit('exit', 0)
      })
      return child
    },
  }
  await assert.rejects(
    submitNotarization({ filePath: '/tmp/app.dmg', env: {
      APPLE_API_ISSUER: 'issuer', APPLE_API_KEY: 'key', APPLE_API_KEY_PATH: '/tmp/key.p8',
    }, retries: 3, deps }),
    /Apple notarization Invalid for submission submission-1/,
  )
  assert.equal(calls, 1)
})

test('accepts only an explicit Accepted Apple notarization result', async () => {
  const calls = []
  const deps = {
    spawn: (_command, args) => {
      calls.push(args)
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ id: 'submission-2', status: 'Accepted' }))
        child.emit('exit', 0)
      })
      return child
    },
  }
  const result = await submitNotarization({ filePath: '/tmp/app.dmg', env: {
    APPLE_API_ISSUER: 'issuer', APPLE_API_KEY: 'key', APPLE_API_KEY_PATH: '/tmp/key.p8',
  }, retries: 3, deps })
  assert.equal(result.status, 'Accepted')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(-2), ['--output-format', 'json'])
})

test('runtime resource snapshot verifies through a symlinked macOS-style temp directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uniopc-runtime-temp-alias-')))
  const actual = join(root, 'actual')
  const alias = join(root, 'alias')
  await mkdir(actual)
  await symlink(actual, alias)
  const archivePath = join(root, 'runtime.tar.gz')
  await writeFile(archivePath, 'trusted runtime')
  const manifest = {
    version: '2026.8.1', platform: 'darwin', arch: 'arm64', archive: 'runtime.tar.gz',
    sha256: createHash('sha256').update('trusted runtime').digest('hex'),
    sizeBytes: Buffer.byteLength('trusted runtime'), nodeVersion: '24.19.0',
  }
  const { stageRuntimeResourceSnapshot } = await import('./build-desktop-release.mjs')
  const snapshot = await stageRuntimeResourceSnapshot({ archivePath, manifest }, { TEMP: alias })
  try {
    assert.equal(await snapshot.verify(), true)
    assert.equal(snapshot.root.startsWith(await realpath(actual)), true)
  } finally {
    await snapshot.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit plugin audit consumes the prepared runtime instead of rebuilding it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-targeted-runtime-'))
  const envFile = join(root, '.env.release')
  await writeFile(envFile, [
    'TAURI_SIGNING_PRIVATE_KEY=inline-key',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=',
    'GITHUB_TOKEN=ci-secret',
    `GITHUB_SHA=${'c'.repeat(40)}`,
    'GITHUB_RUN_ID=4242',
    'CI_JOB_TOKEN=job-secret',
    'UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN=audit-only-token',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY=audit-public-key',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID=audit-key-2026',
    `UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE=${Buffer.alloc(32, 7).toString('base64')}`,
    `UNIOPC_PLUGIN_AUDIT_COMMIT=${'c'.repeat(40)}`,
    'UNIOPC_PLUGIN_AUDIT_TARGET=darwin/arm64',
    'UNIOPC_PLUGIN_AUDIT_RUN_ID=4242',
    `UNIOPC_PLUGIN_AUDIT_CONSUMPTION_DIR=${join(root, 'consumed')}`,
    'UNIOPC_PLUGIN_AUDIT_EXECUTION_RUNTIME=/tmp/linux-runtime.tar.gz',
    'UNIOPC_PLUGIN_RELEASE_MATRIX=release/plugin-release-matrix.json',
    'UNIOPC_PLUGIN_AUDIT_REPORT=release/plugin-audit-report.json',
    'UNIOPC_PREPARED_OPENCLAW_RUNTIME_DIR=/tmp/audited-runtime',
  ].join('\n'))

  const calls = []
  const steps = []
  let preparedRuntimeTarget = null
  let verifiedTarget = null
  await buildDesktopRelease({
    app: 'admin',
    envFile,
    target: 'aarch64-apple-darwin',
    auditPlugins: true,
    allowSkipNotarization: true,
    notarizationMode: 'skip',
  }, {
    ensureRuntimeBundle: async () => {
      throw new Error('prepared runtime must prevent a rebuild')
    },
    installPreparedRuntimeBundle: async ({ sourceDirectory, target }) => {
      steps.push('prepared-runtime')
      assert.equal(sourceDirectory, '/tmp/audited-runtime')
      preparedRuntimeTarget = target
      return { archivePath: '/tmp/audited-runtime/uniopc-engine-runtime-darwin-arm64.tar.gz', skipped: true }
    },
    verifyRuntimeContract: async (target) => {
      steps.push('verify')
      verifiedTarget = target
    },
    stageRuntimeResourceSnapshot: async ({ archivePath }) => fakeRuntimeSnapshot(archivePath),
    auditPlugins: async ({ executionRuntimeArchivePath, packageRuntimeArchivePath, packageTarget, matrixPath, reportPath, env }) => {
      steps.push('plugins')
      assert.equal(executionRuntimeArchivePath, '/tmp/linux-runtime.tar.gz')
      assert.equal(packageRuntimeArchivePath, '/tmp/audited-runtime/uniopc-engine-runtime-darwin-arm64.tar.gz.snapshot')
      assert.equal(packageTarget, 'darwin/arm64')
      assert.equal(matrixPath, 'release/plugin-release-matrix.json')
      assert.equal(reportPath, resolve('release/plugin-audit-report.json'))
      assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, undefined)
      assert.equal(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined)
      assert.equal(env.GITHUB_TOKEN, undefined)
      assert.equal(env.CI_JOB_TOKEN, undefined)
      assert.equal(env.UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN, undefined)
      assert.equal(env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY, 'audit-public-key')
      assert.equal(env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID, 'audit-key-2026')
      assert.equal(env.UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE, Buffer.alloc(32, 7).toString('base64'))
      assert.equal(env.UNIOPC_PLUGIN_AUDIT_COMMIT, 'c'.repeat(40))
      assert.equal(env.UNIOPC_PLUGIN_AUDIT_TARGET, 'darwin/arm64')
      assert.equal(env.UNIOPC_PLUGIN_AUDIT_RUN_ID, '4242')
      assert.equal(env.UNIOPC_PLUGIN_AUDIT_CONSUMPTION_DIR, join(root, 'consumed'))
      assert.equal(env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY, undefined)
      assert.equal(typeof env.PATH, 'string')
      return { ok: true }
    },
    clearStaleRuntimeResourceOutput: async () => { steps.push('clear-runtime-output') },
    spawn: (command, args, options) => {
      steps.push('tauri')
      calls.push({ command, args, env: options.env })
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', 0))
      return child
    },
  })
  assert.deepEqual(preparedRuntimeTarget, { platform: 'darwin', arch: 'arm64' })
  assert.deepEqual(verifiedTarget, { platform: 'darwin', arch: 'arm64' })
  assert.deepEqual(steps, ['prepared-runtime', 'verify', 'plugins', 'clear-runtime-output', 'tauri'])

  assert.deepEqual(calls.map((call) => call.command), ['npm'])
  assert.deepEqual(calls[0].args, [
    'run', 'tauri', '--', 'build', '--target', 'aarch64-apple-darwin',
    '--config', '/tmp/tauri-runtime-resource.json',
  ])
  assert.equal(calls[0].env.UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY, undefined)
})

test('prepared runtime archive is copied under the canonical target name before verification', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'uniopc-prepared-runtime-')))
  const sourceDirectory = join(root, 'prepared')
  const outputDirectory = join(root, 'resources')
  const archive = 'uniopc-engine-runtime-win32-x64.tar.gz'
  const bytes = Buffer.from('audited Windows runtime bytes')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(join(sourceDirectory, archive), bytes)
  await writeFile(join(sourceDirectory, 'uniopc-engine-runtime.catalog.json'), JSON.stringify({
    artifacts: [{
      version: '2026.8.1',
      platform: 'win32',
      arch: 'x64',
      archive,
      sha256,
      sizeBytes: bytes.length,
      nodeVersion: '24.19.0',
    }],
  }))

  const bundle = await installPreparedRuntimeBundle({
    sourceDirectory,
    target: { platform: 'win32', arch: 'x64' },
    outputDirectory,
  })

  assert.equal(bundle.archivePath, join(outputDirectory, archive))
  assert.deepEqual(await readFile(bundle.archivePath), bytes)
  assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, 'uniopc-engine-runtime.catalog.json'), 'utf8')).artifacts, [bundle.manifest])
})

test('desktop release stops before Tauri when the prepared runtime cannot be accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-prepared-runtime-reject-'))
  const envFile = join(root, '.env.release')
  await writeFile(envFile, [
    'TAURI_SIGNING_PRIVATE_KEY=inline-key',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=',
    'APPLE_CODESIGN_IDENTITY=-',
    'UNIOPC_PREPARED_OPENCLAW_RUNTIME_DIR=/tmp/changed-runtime',
  ].join('\n'))
  let spawned = false
  await assert.rejects(
    buildDesktopRelease({
      app: 'admin',
      envFile,
      allowSkipNotarization: true,
      notarizationMode: 'skip',
    }, {
      ensureRuntimeBundle: async () => {
        throw new Error('prepared runtime must prevent a rebuild')
      },
      installPreparedRuntimeBundle: async () => {
        throw new Error('prepared runtime contract rejected')
      },
      clearStaleRuntimeResourceOutput: async () => {},
      spawn: () => {
        spawned = true
        throw new Error('must not package')
      },
    }),
    /prepared runtime contract rejected/,
  )
  assert.equal(spawned, false)
})

test('Windows x64 release reaches Tauri without Apple signing or notarization inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-windows-release-policy-'))
  const envFile = join(root, '.env.release')
  await writeFile(envFile, [
    'TAURI_SIGNING_PRIVATE_KEY=inline-key',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=',
    'CI=true',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY=audit-public-key',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID=audit-key-id',
    'UNIOPC_PLUGIN_AUDIT_TARGET=win32/x64',
    'APPLE_API_ISSUER=apple-issuer',
    'APPLE_API_KEY=apple-key',
    'APPLE_API_KEY_PATH=apple-key-path',
    'APPLE_ID=apple-id',
    'APPLE_PASSWORD=apple-password',
    'APPLE_TEAM_ID=apple-team',
    'APPLE_CERTIFICATE=apple-certificate',
    'APPLE_CERTIFICATE_PASSWORD=apple-certificate-password',
    'APPLE_CODESIGN_IDENTITY=apple-signing-identity',
    'APPLE_SIGNING_IDENTITY=legacy-apple-signing-identity',
    'APPLE_FUTURE_CREDENTIAL=future-apple-credential',
  ].join('\n'))

  const steps = []
  const calls = []
  await buildDesktopRelease({
    app: 'admin',
    envFile,
    allowSkipNotarization: false,
    notarizationMode: 'post-build',
    target: 'x86_64-pc-windows-msvc',
  }, {
    ensureRuntimeBundle: async target => {
      steps.push('runtime')
      assert.deepEqual(target, { platform: 'win32', arch: 'x64', force: true })
      return { archivePath: '/tmp/runtime.tar.gz' }
    },
    verifyRuntimeContract: async target => {
      steps.push('verify')
      assert.deepEqual(target, { platform: 'win32', arch: 'x64' })
    },
    stageRuntimeResourceSnapshot: async ({ archivePath }) => fakeRuntimeSnapshot(archivePath),
    auditPlugins: async () => { throw new Error('desktop release must not audit cloud plugins by default') },
    clearStaleRuntimeResourceOutput: async () => {},
    prepareBundledPlugins: async () => { steps.push('offline-plugin-dependencies') },
    spawn: (command, args, options) => {
      steps.push('tauri')
      calls.push({ command, args, env: options.env })
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', 0))
      return child
    },
  })

  assert.deepEqual(steps, ['runtime', 'verify', 'offline-plugin-dependencies', 'tauri'])
  assert.deepEqual(calls[0].args, [
    'run', 'tauri', '--', 'build', '--target', 'x86_64-pc-windows-msvc',
    '--config', '/tmp/tauri-runtime-resource.json',
  ])
  for (const key of [
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'APPLE_API_KEY_PATH',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_CODESIGN_IDENTITY',
    'APPLE_SIGNING_IDENTITY',
    'APPLE_FUTURE_CREDENTIAL',
  ]) assert.equal(calls[0].env[key], undefined, `${key} must not reach a Windows build`)
  assert.equal(calls[0].env.TAURI_SIGNING_PRIVATE_KEY, 'inline-key')
})

test('desktop build rejects producer-only audit private keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-build-private-audit-key-'))
  const envFile = join(root, '.env.release')
  await writeFile(envFile, [
    'TAURI_SIGNING_PRIVATE_KEY=inline-key',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY=producer-secret',
  ].join('\n'))
  await assert.rejects(
    buildDesktopRelease({
      app: 'admin',
      envFile,
      allowSkipNotarization: true,
      notarizationMode: 'skip',
    }),
    /producer-only/,
  )
})

test('desktop build refuses a runtime snapshot changed after staging and before Tauri', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-build-runtime-swap-'))
  const envFile = join(root, '.env.release')
  await writeFile(envFile, [
    'TAURI_SIGNING_PRIVATE_KEY=inline-key',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=',
    'APPLE_CODESIGN_IDENTITY=-',
  ].join('\n'))
  let verifies = 0
  let spawned = false
  await assert.rejects(
    buildDesktopRelease({
      app: 'admin',
      envFile,
      allowSkipNotarization: true,
      notarizationMode: 'skip',
    }, {
      ensureRuntimeBundle: async () => ({ archivePath: '/tmp/runtime.tar.gz' }),
      verifyRuntimeContract: async () => undefined,
      stageRuntimeResourceSnapshot: async () => ({
        ...fakeRuntimeSnapshot(),
        verify: async () => {
          verifies += 1
          return verifies === 1
        },
      }),
      auditPlugins: async () => ({ ok: true }),
      clearStaleRuntimeResourceOutput: async () => {},
      spawn: () => {
        spawned = true
        throw new Error('must not package a changed runtime snapshot')
      },
    }),
    /snapshot verification failed/,
  )
  assert.equal(verifies, 2)
  assert.equal(spawned, false)
})

test('plugin audit uses an empty private home before the signing key is read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-build-audit-home-'))
  const originalHome = join(root, 'release-home')
  const keyPath = join(originalHome, '.tauri', 'imai-updater-ci.key')
  const envFile = join(root, '.env.release')
  await mkdir(join(originalHome, '.tauri'), { recursive: true })
  await writeFile(keyPath, 'KEY_BEFORE_AUDIT')
  await writeFile(envFile, [
    `HOME=${originalHome}`,
    `USERPROFILE=${originalHome}`,
    `TAURI_SIGNING_PRIVATE_KEY_PATH=${keyPath}`,
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=',
    'APPLE_CODESIGN_IDENTITY=-',
    'UNIOPC_PLUGIN_RELEASE_MATRIX=release/plugin-release-matrix.json',
  ].join('\n'))

  let auditHome
  let tauriKey
  await buildDesktopRelease({
    app: 'admin',
    envFile,
    allowSkipNotarization: true,
    notarizationMode: 'skip',
    auditPlugins: true,
  }, {
    ensureRuntimeBundle: async () => ({ archivePath: '/tmp/runtime.tar.gz' }),
    verifyRuntimeContract: async () => undefined,
    stageRuntimeResourceSnapshot: async ({ archivePath }) => fakeRuntimeSnapshot(archivePath),
    auditPlugins: async ({ env }) => {
      auditHome = env.HOME
      assert.notEqual(env.HOME, originalHome)
      assert.equal(env.USERPROFILE, env.HOME)
      assert.equal(env.APPDATA.startsWith(env.HOME), true)
      assert.equal(env.LOCALAPPDATA.startsWith(env.HOME), true)
      assert.equal(env.XDG_CACHE_HOME.startsWith(env.HOME), true)
      assert.equal(env.XDG_CONFIG_HOME.startsWith(env.HOME), true)
      assert.equal(env.XDG_DATA_HOME.startsWith(env.HOME), true)
      assert.equal(env.HOMEDRIVE + env.HOMEPATH, env.HOME)
      await assert.rejects(readFile(join(env.HOME, '.tauri', 'imai-updater-ci.key'), 'utf8'))
      await writeFile(keyPath, 'KEY_AFTER_AUDIT')
      return { ok: true }
    },
    clearStaleRuntimeResourceOutput: async () => {},
    spawn: (_command, _args, options) => {
      tauriKey = options.env.TAURI_SIGNING_PRIVATE_KEY
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', 0))
      return child
    },
  })

  assert.equal(typeof auditHome, 'string')
  assert.equal(tauriKey, 'KEY_AFTER_AUDIT')
})

test('skip notarization strips Apple certificate and notary credentials but keeps ad-hoc signing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-build-release-'))
  const envFile = join(root, '.env.release')
  await writeFile(envFile, [
    'TAURI_SIGNING_PRIVATE_KEY=inline-key',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=',
    'APPLE_CERTIFICATE=',
    'APPLE_CERTIFICATE_PASSWORD=',
    'APPLE_CODESIGN_IDENTITY=-',
    'APPLE_API_ISSUER=issuer',
    'APPLE_API_KEY=key-id',
    'APPLE_API_KEY_PATH=/tmp/key.p8',
  ].join('\n'))

  const calls = []
  await buildDesktopRelease({
    app: 'admin',
    envFile,
    target: 'aarch64-apple-darwin',
    allowSkipNotarization: true,
    notarizationMode: 'skip',
  }, {
    ensureRuntimeBundle: async () => ({ archivePath: '/tmp/runtime.tar.gz', skipped: true }),
    verifyRuntimeContract: async () => undefined,
    stageRuntimeResourceSnapshot: async ({ archivePath }) => fakeRuntimeSnapshot(archivePath),
    auditPlugins: async () => ({ ok: true }),
    clearStaleRuntimeResourceOutput: async () => {},
    spawn: (command, args, options) => {
      calls.push({ command, args, env: options.env })
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', 0))
      return child
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'npm')
  assert.equal(calls[0].env.TAURI_SIGNING_PRIVATE_KEY, 'inline-key')
  assert.equal(calls[0].env.APPLE_CERTIFICATE, undefined)
  assert.equal(calls[0].env.APPLE_CERTIFICATE_PASSWORD, undefined)
  assert.equal(calls[0].env.APPLE_CODESIGN_IDENTITY, '-')
  assert.equal(calls[0].env.APPLE_API_ISSUER, undefined)
  assert.equal(calls[0].env.APPLE_API_KEY, undefined)
  assert.equal(calls[0].env.APPLE_API_KEY_PATH, undefined)
})

test('build release fails closed on plugin audit before Tauri packaging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-build-plugin-gate-'))
  const envFile = join(root, '.env.release')
  await writeFile(envFile, [
    'TAURI_SIGNING_PRIVATE_KEY=inline-key',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=',
    'APPLE_CODESIGN_IDENTITY=-',
    'UNIOPC_PLUGIN_RELEASE_MATRIX=missing-release-matrix.json',
  ].join('\n'))
  const steps = []

  await assert.rejects(
    buildDesktopRelease({
      app: 'admin',
      envFile,
      allowSkipNotarization: true,
      notarizationMode: 'skip',
      auditPlugins: true,
    }, {
      ensureRuntimeBundle: async () => {
        steps.push('runtime')
        return { archivePath: '/tmp/runtime.tar.gz' }
      },
      verifyRuntimeContract: async () => {
        steps.push('verify')
      },
      stageRuntimeResourceSnapshot: async ({ archivePath }) => fakeRuntimeSnapshot(archivePath),
      auditPlugins: async () => {
        steps.push('plugins')
        return { ok: false, errors: [{ code: 'artifact_missing' }] }
      },
      clearStaleRuntimeResourceOutput: async () => {},
      spawn: () => {
        steps.push('tauri')
        throw new Error('must not package')
      },
    }),
    /云端插件发布门禁未通过/,
  )
  assert.deepEqual(steps, ['runtime', 'verify', 'plugins'])
})

test('explicit local ARM64 release records an unaudited build and still notarizes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-build-unaudited-'))
  const envFile = join(root, '.env.release')
  const reportPath = join(root, 'plugin-audit-report.json')
  await writeFile(envFile, [
    'CI=',
    'TAURI_SIGNING_PRIVATE_KEY=inline-key',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=',
    'APPLE_CODESIGN_IDENTITY=-',
    'APPLE_API_ISSUER=test-issuer',
    'APPLE_API_KEY=test-key',
    'APPLE_API_KEY_PATH=/tmp/test-key.p8',
    `UNIOPC_PLUGIN_AUDIT_REPORT=${reportPath}`,
  ].join('\n'))
  const steps = []
  await buildDesktopRelease({
    app: 'admin',
    envFile,
    target: 'aarch64-apple-darwin',
    allowUnauditedPlugins: true,
    notarizationMode: 'post-build',
  }, {
    ensureRuntimeBundle: async () => {
      steps.push('runtime')
      return { archivePath: '/tmp/runtime.tar.gz' }
    },
    verifyRuntimeContract: async () => { steps.push('verify') },
    stageRuntimeResourceSnapshot: async ({ archivePath }) => fakeRuntimeSnapshot(archivePath),
    auditPlugins: async () => { throw new Error('plugin audit must not run in manual mode') },
    notarizeReleaseArtifacts: async () => { steps.push('notarize') },
    signBundledPluginBinaries: async () => { steps.push('sign-plugins') },
    clearStaleRuntimeResourceOutput: async () => {},
    spawn: (_command, _args, options) => {
      steps.push('tauri')
      assert.equal(options.env.TAURI_SIGNING_PRIVATE_KEY, 'inline-key')
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('exit', 0))
      return child
    },
  })
  assert.deepEqual(steps, ['runtime', 'verify', 'sign-plugins', 'tauri', 'notarize'])
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), {
    schemaVersion: 1,
    ok: false,
    skipped: true,
    reason: 'manual_unaudited_plugins',
    target: 'darwin/arm64',
  })
})

test('unaudited plugin mode rejects CI and skipped notarization before runtime preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-build-unaudited-guards-'))
  const envFile = join(root, '.env.release')
  await writeFile(envFile, [
    'CI=true',
    'APPLE_API_ISSUER=test-issuer',
    'APPLE_API_KEY=test-key',
    'APPLE_API_KEY_PATH=/tmp/test-key.p8',
  ].join('\n'))
  const deps = {
    ensureRuntimeBundle: async () => { throw new Error('runtime preparation must not start') },
  }
  await assert.rejects(
    buildDesktopRelease({
      app: 'admin', envFile, target: 'aarch64-apple-darwin',
      allowUnauditedPlugins: true, notarizationMode: 'post-build',
    }, deps),
    /only for a local darwin\/arm64 build/,
  )
  await writeFile(envFile, 'CI=\n')
  await assert.rejects(
    buildDesktopRelease({
      app: 'admin', envFile, target: 'aarch64-apple-darwin',
      allowUnauditedPlugins: true, notarizationMode: 'skip',
    }, deps),
    /still requires Apple notarization/,
  )
})

test('rebuilds and signs updater archive after app notarization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-updater-artifact-'))
  const appPath = join(root, 'Uniopc.app')
  const updaterPath = join(root, 'Uniopc.app.tar.gz')
  const signaturePath = `${updaterPath}.sig`
  await mkdir(appPath)
  await writeFile(updaterPath, 'old archive')
  await writeFile(signaturePath, 'old signature')

  const calls = []
  await recreateUpdaterArtifact({
    appPath,
    updaterPath,
    signaturePath,
    env: { TAURI_SIGNING_PRIVATE_KEY: 'inline-key', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
    deps: {
      spawn: (command, args, options) => {
        calls.push({ command, args, env: options.env })
        const child = new EventEmitter()
        queueMicrotask(async () => {
          if (command === 'tar') await writeFile(updaterPath, 'new archive')
          if (command === 'npm') await writeFile(signaturePath, 'new signature')
          child.emit('exit', 0)
        })
        return child
      },
    },
  })

  assert.deepEqual(calls.map(call => call.command), ['tar', 'npm'])
  assert.deepEqual(calls[0].args, ['--no-xattrs', '--no-mac-metadata', '-czf', updaterPath, '-C', root, 'Uniopc.app'])
  assert.equal(calls[0].env.COPYFILE_DISABLE, '1')
  assert.deepEqual(calls[1].args, ['run', 'tauri', '--', 'signer', 'sign', updaterPath])
})
