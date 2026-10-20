import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { appendFile, link, mkdir, mkdtemp, readFile, rename, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import test from 'node:test'

async function loadAuditModule() {
  return import('./audit-openclaw-plugin.mjs')
}

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function testCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(testCanonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${testCanonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

const testReleaseNonce = Buffer.alloc(32, 7).toString('base64')
const testReleaseCommit = 'c'.repeat(40)
const testWorkerImageDigest = `sha256:${'d'.repeat(64)}`
const testWorkerImage = `registry.example/uniopc/plugin-audit@${testWorkerImageDigest}`
const testWorkerLock = {
  schemaVersion: 1,
  protocol: {
    id: 'uniopc-openclaw-plugin-audit',
    version: 1,
    reportSchemaVersion: 1,
  },
  workers: [
    { platform: 'linux/amd64', status: 'available', image: testWorkerImage },
    { platform: 'linux/arm64', status: 'unavailable', image: null },
  ],
}

function releaseArtifactProof(item) {
  const capabilityProof = {
    declared: [`${item.id}_read`],
    readOnlyTool: `${item.id}_read`,
    readOnlyInvocationHash: sha256(testCanonicalJson({ name: `${item.id}_read`, arguments: {} })),
    runtimeRegistered: [`${item.id}_read`],
  }
  return {
    artifactId: item.id,
    sha256: item.sha256,
    pluginId: item.pluginId,
    pluginApi: item.pluginApi,
    capabilities: {
      ...capabilityProof,
      hash: sha256(testCanonicalJson(capabilityProof)),
      runtimeVerified: true,
    },
    proof: {
      builder: true,
      validator: true,
      inspector: true,
      installed: true,
      enabled: true,
      restarted: true,
      runtimeInspected: true,
      readOnlyInvoked: true,
      disabled: true,
      uninstalled: true,
      cleaned: true,
    },
  }
}

function releaseEnvelopeFixture({ matrix, privateKey, runtimeSha256, packageRuntimeSha256 = runtimeSha256 }) {
  return schema3ReleaseEnvelopeFixture({
    matrix,
    privateKey,
    executionRuntimeSha256: runtimeSha256,
    packageRuntimeSha256,
    packageTarget: 'linux/x64',
  })
}

function schema3ReleaseEnvelopeFixture({ matrix, privateKey, executionRuntimeSha256, packageRuntimeSha256, packageTarget = 'win32/x64' }) {
  const payload = {
    schemaVersion: 3,
    release: {
      nonce: testReleaseNonce,
      commit: testReleaseCommit,
      target: packageTarget,
      runId: 'ci-run-4242',
      issuedAt: '2026-09-10T00:00:00.000Z',
      expiresAt: '2026-09-10T01:00:00.000Z',
    },
    matrix: {
      sha256: sha256(testCanonicalJson(matrix)),
      artifactCount: matrix.artifacts.length,
    },
    artifacts: matrix.artifacts.map(releaseArtifactProof),
    executionRuntime: {
      platform: 'linux/x64',
      openclawVersion: '2026.8.1',
      nodeVersion: '24.19.0',
      inspectorVersion: '0.3.24',
      archiveSha256: executionRuntimeSha256,
    },
    packageRuntime: {
      target: packageTarget,
      openclawVersion: '2026.8.1',
      nodeVersion: '24.19.0',
      archiveSha256: packageRuntimeSha256,
    },
    sandbox: {
      enforced: true,
      kind: 'linux-container',
      engine: 'docker',
      image: testWorkerImage,
      platform: 'linux/amd64',
      protocol: { ...testWorkerLock.protocol },
    },
  }
  return {
    envelope: {
      schemaVersion: 3,
      keyId: 'audit-key-2026',
      payload,
      signature: sign(null, Buffer.from(testCanonicalJson(payload)), privateKey).toString('base64'),
    },
    payload,
  }
}

function releaseVerifierEnv(publicKey, ledgerDirectory = '') {
  return {
    UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID: 'audit-key-2026',
    UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE: testReleaseNonce,
    UNIOPC_PLUGIN_AUDIT_COMMIT: testReleaseCommit,
    UNIOPC_PLUGIN_AUDIT_TARGET: 'linux/x64',
    UNIOPC_PLUGIN_AUDIT_RUN_ID: 'ci-run-4242',
    UNIOPC_PLUGIN_AUDIT_CONSUMPTION_DIR: ledgerDirectory,
  }
}

function successfulWorkerReport(matrix) {
  return {
    schemaVersion: 1,
    ok: true,
    errors: [],
    warnings: [],
    compatibility: {
      hostVersion: '2026.8.1',
      artifacts: matrix.artifacts.map((item) => ({
        artifactId: item.id,
        pluginId: item.pluginId,
        pluginApi: item.pluginApi,
        hostVersion: '2026.8.1',
        compatible: true,
        checks: { builder: true, validator: true, inspector: true },
      })),
    },
    capabilities: {
      artifacts: matrix.artifacts.map((item) => ({
        artifactId: item.id,
        declared: [item.readOnlyTool.name],
        readOnlyDeclared: [item.readOnlyTool.name],
        runtimeRegistered: [item.readOnlyTool.name],
        runtimeVerified: true,
      })),
    },
    releaseMatrix: {
      runtimeOwnership: { mode: 'owned-foreground', cleaned: true },
      artifacts: matrix.artifacts.map((item) => ({
        artifactId: item.id,
        sha256Verified: true,
        identityVerified: true,
        compatibilityVerified: true,
        installed: true,
        enabled: true,
        restarted: true,
        runtimeInspected: true,
        readOnlyInvoked: true,
        disabled: true,
        uninstalled: true,
      })),
    },
  }
}

function runProcess(command, args, options) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectProcess)
    child.once('exit', (code) => resolveProcess({ code, stdout, stderr }))
  })
}

function withTestSandbox(deps = {}, sandboxOverrides = {}) {
  const {
    runCommand = async () => successfulCommandResult('{}'),
    restartRuntime = async () => ({ ok: true }),
    quiescePluginProcesses = async () => true,
    ...controllerDeps
  } = deps
  return {
    ...controllerDeps,
    skipInspectorPathVerification: true,
    sandbox: {
      enforced: true,
      kind: 'windows-job',
      runCommand,
      restartRuntime,
      stageArtifact: async (...args) => (await loadAuditModule()).stageImmutableArtifact(...args),
      quiesce: quiescePluginProcesses,
      close: async () => ({ cleaned: true }),
      ...sandboxOverrides,
    },
  }
}

function testAuditEnvironment(root) {
  return {
    PATH: '',
    TEMP: join(root, 'temp'),
    TMP: join(root, 'temp'),
    UNIOPC_PLUGIN_AUDIT_HOME: join(root, 'audit-home'),
    UNIOPC_PLUGIN_AUDIT_STATE_DIR: join(root, 'audit-state'),
    UNIOPC_PLUGIN_AUDIT_CONFIG_PATH: join(root, 'audit-state', 'config.json'),
    UNIOPC_PLUGIN_AUDIT_GATEWAY_URL: 'ws://127.0.0.1:12345',
    UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN: 'audit-token',
  }
}

async function createTarArchive(sourceRoot, archivePath) {
  const result = await runProcess('tar', ['-czf', archivePath, '-C', sourceRoot, '.'], {
    cwd: sourceRoot,
    env: process.env,
  })
  assert.equal(result.code, 0, result.stderr)
}

async function writePluginFixture(root, {
  compatibility = '>=2026.8.1',
  minHostCompatibility = '>=2026.8.1',
  source = "import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin'\nimport { jsonResult } from 'openclaw/plugin-sdk/tool-results'\n",
  tools = ['fixture_read'],
} = {}) {
  await mkdir(join(root, 'dist'), { recursive: true })
  const openclaw = {
    extensions: ['./dist/index.js'],
    install: {},
  }
  if (minHostCompatibility !== null) openclaw.install.minHostVersion = minHostCompatibility
  if (compatibility !== null) openclaw.compat = { pluginApi: compatibility }
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: '@uniopc/audit-fixture',
    version: '1.0.0',
    type: 'module',
    openclaw,
  }))
  await writeFile(join(root, 'openclaw.plugin.json'), JSON.stringify({
    id: 'audit-fixture',
    name: 'Audit Fixture',
    version: '1.0.0',
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    contracts: { tools },
    toolMetadata: Object.fromEntries(tools.map((name) => [name, { replaySafe: true, sideEffecting: false }])),
  }))
  await writeFile(join(root, 'dist', 'index.js'), source)
  return root
}

test('static audit rejects removed 1.x surfaces and accepts focused SDK imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-static-'))
  await writePluginFixture(root, {
    source: [
      "import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin'",
      "import { jsonResult } from 'openclaw/plugin-sdk/tool-results'",
      "import { registerPlugin } from 'openclaw/plugin-sdk'",
      'export function register(api) {',
      '  api.runtime.config.loadConfig()',
      '  api.runtime.config.writeConfigFile({})',
      '  api.runtime.agent.session.resolveSessionFilePath()',
      '  api.registerMemoryEmbeddingProvider({})',
      '}',
      'function sendLegacy() { return { chatId: "c", channelId: "ch", roomId: "r", conversationId: "v" } }',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), [
    'removed_memory_embedding_registration',
    'removed_outbound_result_field',
    'removed_root_sdk_import',
    'removed_runtime_config_access',
    'removed_session_file_helper',
  ])
  assert.equal(report.warnings.length, 0)
  assert.equal(report.compatibility.pluginApi, '>=2026.8.1')
})

test('static audit warns for the temporarily adapted broad runtime import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-broad-'))
  await writePluginFixture(root, {
    source: "import * as runtime from 'openclaw/plugin-sdk/runtime'\nvoid runtime",
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.warnings.map(({ code }) => code), ['broad_sdk_import'])
})

test('static audit rejects a side-effect root SDK import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-root-import-'))
  await writePluginFixture(root, { source: "import 'openclaw/plugin-sdk'\n" })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), ['removed_root_sdk_import'])
})

test('static audit follows aliases, destructuring, and computed removed APIs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-ast-alias-'))
  await writePluginFixture(root, {
    source: [
      "await import('openclaw/plugin-sdk')",
      'export function register(api) {',
      '  const runtimeAlias = api.runtime',
      '  const { config: configAlias, agent: agentAlias } = runtimeAlias',
      "  const loadAlias = configAlias['loadConfig']",
      '  loadAlias()',
      '  const { session: sessionAlias } = agentAlias',
      "  const sessionFileAlias = sessionAlias['resolveSessionFilePath']",
      '  sessionFileAlias()',
      "  const memoryAlias = api['registerMemoryEmbeddingProvider']",
      '  memoryAlias({})',
      '}',
      "function legacy() { return { ['chatId']: 'legacy' } }",
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), [
    'removed_memory_embedding_registration',
    'removed_outbound_result_field',
    'removed_root_sdk_import',
    'removed_runtime_config_access',
    'removed_session_file_helper',
  ])
})

test('static audit traces API origins through exported register bindings and wrappers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-exported-register-'))
  await writePluginFixture(root, {
    source: [
      'const implementation = api => {',
      '  api.runtime.config.loadConfig()',
      '  return { chatId: "legacy" }',
      '}',
      'const memoryImplementation = api => api.registerMemoryEmbeddingProvider({})',
      'const sessionImplementation = api => api.runtime.agent.session.resolveSessionFilePath()',
      'export { memoryImplementation as register }',
      'export default { register: implementation }',
      'export const wrapped = { register(...args) { return sessionImplementation(...args) } }',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), [
    'removed_memory_embedding_registration',
    'removed_outbound_result_field',
    'removed_runtime_config_access',
    'removed_session_file_helper',
  ])
})

test('static audit propagates the API origin to the matching wrapper parameter position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-wrapper-position-'))
  await writePluginFixture(root, {
    source: [
      'function helper(options, api) {',
      '  void options',
      '  api.runtime.config.loadConfig()',
      '}',
      'export function register(api) {',
      '  helper({ safe: true }, api)',
      '}',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), ['removed_runtime_config_access'])
})

test('static audit conservatively tracks API forwarding into a rest parameter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-wrapper-rest-'))
  await writePluginFixture(root, {
    source: [
      'function helper(...values) {',
      '  values[1].runtime.config.loadConfig()',
      '}',
      'export function register(api) {',
      '  helper({ safe: true }, api)',
      '}',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), ['dynamic_surface_unverified'])
})

test('static audit fails closed when a spread makes the forwarded API position ambiguous', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-wrapper-spread-'))
  await writePluginFixture(root, {
    source: [
      'function helper(options, api) {',
      '  void options',
      '  void api',
      '}',
      'export function register(api, ...options) {',
      '  helper(...options, api)',
      '}',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), ['dynamic_surface_unverified'])
})

test('static audit resolves exported plugin objects and definePlugin factories through aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-exported-object-'))
  await writePluginFixture(root, {
    source: [
      'const configImpl = api => api.runtime.config.loadConfig()',
      'const objectPlugin = { register: configImpl }',
      'const objectAlias = objectPlugin',
      'export default objectAlias',
      'const memoryImpl = api => api.registerMemoryEmbeddingProvider({})',
      'const factory = definePlugin',
      'export const secondary = factory({ register: memoryImpl })',
      'export { secondary as plugin }',
      'const sessionImpl = api => api.runtime.agent.session.resolveSessionFilePath()',
      'const createPlugin = () => ({ register: sessionImpl })',
      'export const generated = createPlugin()',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), [
    'removed_memory_embedding_registration',
    'removed_runtime_config_access',
    'removed_session_file_helper',
  ])
})

test('static audit ignores removed API words inside comments and strings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-ast-comments-'))
  await writePluginFixture(root, {
    source: [
      '// api.runtime.config.loadConfig()',
      '// return { chatId: "not code" }',
      'const documentation = "registerMemoryEmbeddingProvider() resolveSessionFilePath()"',
      'void documentation',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors, [])
})

test('static audit resolves constant dynamic import and require specifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-ast-dynamic-import-'))
  await writePluginFixture(root, {
    source: [
      "const sdkRoot = 'openclaw/plugin-' + 'sdk'",
      'await import(sdkRoot)',
      "const runtimeRoot = `openclaw/plugin-sdk/runtime`",
      'require(runtimeRoot)',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), ['removed_root_sdk_import'])
  assert.deepEqual(report.warnings.map(({ code }) => code), ['broad_sdk_import'])
})

test('static audit tracks register parameters, computed consts, assignments, and implicit returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-ast-bindings-'))
  await writePluginFixture(root, {
    source: [
      'export default {',
      '  register(pluginApi) {',
      '    const runtimeAlias = pluginApi.runtime',
      '    const { config: configAlias, agent: agentAlias } = runtimeAlias',
      "    const method = 'writeConfigFile'",
      '    const writeAlias = configAlias[method]',
      '    writeAlias({})',
      '    let assignedApi',
      '    assignedApi = pluginApi',
      '    const { registerMemoryEmbeddingProvider: memoryAlias } = assignedApi',
      '    memoryAlias({})',
      '    const sessionAlias = agentAlias.session',
      "    sessionAlias['appendSessionTranscriptMessage']()",
      '  },',
      '}',
      "const legacyResult = () => ({ ['conversationId']: 'legacy' })",
      'void legacyResult',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), [
    'removed_memory_embedding_registration',
    'removed_outbound_result_field',
    'removed_runtime_config_access',
    'removed_session_file_helper',
  ])
})

test('static audit fails closed for unresolved dynamic imports and sensitive runtime members', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-ast-dynamic-unknown-'))
  await writePluginFixture(root, {
    source: [
      'export function register(pluginApi) {',
      '  const unknownMethod = getMethod()',
      '  pluginApi.runtime.config[unknownMethod]()',
      '}',
      'const unknownSdk = getSdk()',
      'import(unknownSdk)',
      'require(unknownSdk)',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), ['dynamic_surface_unverified'])
})

test('static audit fails closed for unresolved sensitive member references before invocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-ast-dynamic-reference-'))
  await writePluginFixture(root, {
    source: [
      'export function register(pluginApi) {',
      '  const unknownMethod = getMethod()',
      '  const unresolved = pluginApi.runtime.config[unknownMethod]',
      '  return unresolved',
      '}',
    ].join('\n'),
  })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.deepEqual(report.errors.map(({ code }) => code), ['dynamic_surface_unverified'])
})

test('static audit fails closed when compatibility metadata is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-compat-'))
  await writePluginFixture(root, { compatibility: null })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.equal(report.compatibility.pluginApi, null)
  assert.deepEqual(report.errors.map(({ code }) => code), ['compatibility_missing'])
})

test('static audit requires the minimum host compatibility declaration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-host-compat-'))
  await writePluginFixture(root, { minHostCompatibility: null })

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.equal(report.compatibility.minHostVersion, null)
  assert.deepEqual(report.errors.map(({ code }) => code), ['compatibility_missing'])
  assert.equal(report.compatibility.compatible, false)
})

test('static audit never echoes untrusted paths or the underlying English brand', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-redaction-'))
  await writePluginFixture(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: '@uniopc/audit-fixture',
    version: '1.0.0',
    openclaw: {
      extensions: ['./dist/index.js'],
      install: { minHostVersion: '>=2026.8.1' },
      compat: { pluginApi: `>=2026.8.1 ${root} OpenClaw` },
    },
  }))
  await writeFile(join(root, 'openclaw.plugin.json'), JSON.stringify({
    id: 'OpenClaw/private/path',
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    contracts: { tools: ['OpenClaw_private_tool'] },
    toolMetadata: { OpenClaw_private_tool: { sideEffecting: false } },
  }))

  const { auditPluginDirectory } = await loadAuditModule()
  const report = await auditPluginDirectory(root)
  assert.equal(report.compatibility.pluginApi, null)
  assert.equal(report.plugin.id, 'runtime-plugin')
  assert.deepEqual(report.capabilities.declared, ['runtime_private_tool'])
  assert.deepEqual(report.capabilities.readOnlyDeclared, ['runtime_private_tool'])
  const json = JSON.stringify(report)
  assert.equal(json.includes(root), false)
  assert.equal(json.includes('OpenClaw'), false)
  assert.equal(json.includes('private/path'), false)
})

function successfulCommandResult(stdout = '') {
  return { code: 0, stdout, stderr: '' }
}

test('release result fails closed when its owned runtime cannot be cleaned', async () => {
  const { releaseMatrixPassed } = await loadAuditModule()
  assert.equal(releaseMatrixPassed({
    errors: [],
    capabilities: { artifacts: [] },
    releaseMatrix: {
      runtimeOwnership: { mode: 'owned-foreground', cleaned: false },
      artifacts: [],
    },
  }), false)
})

test('owned runtime cleanup retains a slow process handle until its tree is gone', async () => {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdout = { resume() {} }
  child.stderr = { resume() {} }
  child.killCalls = 0
  child.kill = () => { child.killCalls += 1 }
  const terminated = []
  const checkedTrees = []
  const treeChecks = [false, true]
  const { createForegroundGatewaySupervisor } = await loadAuditModule()
  const supervisor = createForegroundGatewaySupervisor({
    runtime: { nodePath: 'node', cliPath: 'engine-cli.mjs', packageRoot: 'engine-package' },
    env: {
      OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:12345',
      OPENCLAW_GATEWAY_TOKEN: 'one-run-token',
    },
    deps: {
      spawnProcess: () => child,
      runCommand: async () => successfulCommandResult('{}'),
      delay: async () => undefined,
      listProcessTree: async () => [4242, 4343],
      terminateProcessTree: async (pids) => { terminated.push(pids); return true },
      stopPollAttempts: 1,
      processTreeGone: async (pids) => {
        checkedTrees.push(pids)
        return treeChecks.shift()
      },
    },
  })

  assert.deepEqual(await supervisor.restart(), { ok: true })
  assert.deepEqual(await supervisor.restart(), { ok: false })
  assert.equal(await supervisor.stop(), true)
  assert.equal(child.killCalls, 2)
  assert.deepEqual(terminated, [[4242, 4343], [4242, 4343]])
  assert.deepEqual(checkedTrees, [[4242, 4343], [4242, 4343]])
})

test('owned runtime cleanup terminates descendants after the gateway root already exited', async () => {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdout = { resume() {} }
  child.stderr = { resume() {} }
  child.kill = () => true
  const terminated = []
  const treeChecks = [false, true]
  const { createForegroundGatewaySupervisor } = await loadAuditModule()
  const supervisor = createForegroundGatewaySupervisor({
    runtime: { nodePath: 'node', cliPath: 'engine-cli.mjs', packageRoot: 'engine-package' },
    env: {
      OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:12345',
      OPENCLAW_GATEWAY_TOKEN: 'one-run-token',
    },
    deps: {
      spawnProcess: () => child,
      runCommand: async () => successfulCommandResult('{}'),
      delay: async () => undefined,
      listProcessTree: async () => [4242, 4343],
      terminateProcessTree: async (pids) => { terminated.push(pids); return true },
      stopPollAttempts: 1,
      processTreeGone: async () => treeChecks.shift(),
    },
  })

  assert.deepEqual(await supervisor.restart(), { ok: true })
  child.emit('exit', 0)
  assert.equal(await supervisor.stop(), true)
  assert.deepEqual(terminated, [[4242, 4343]])
})

test('read-only invocation requires a successful locked RPC result', async () => {
  const { toolInvocationSucceeded } = await loadAuditModule()
  assert.equal(toolInvocationSucceeded({ ok: true, output: { content: [] } }), true)
  assert.equal(toolInvocationSucceeded({ ok: true }), false)
  assert.equal(toolInvocationSucceeded({ ok: true, output: {} }), false)
  assert.equal(toolInvocationSucceeded({ ok: true, output: { isError: true } }), false)
  assert.equal(toolInvocationSucceeded({ result: { isError: true } }), false)
  assert.equal(toolInvocationSucceeded({ error: { code: -32000 } }), false)
  assert.equal(toolInvocationSucceeded({}), false)
})

test('release matrix rejects manifest-only capabilities as runtime proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-runtime-proof-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'))
  const artifact = join(root, 'fixture.tgz')
  await writeFile(artifact, 'fixture archive')
  const commands = []

  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    baseDir: root,
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: 'entitled-fixture',
        artifact: 'fixture.tgz',
        sha256: 'f8b1f712f078009f786ea23ebe0a2b14498c80f454453ed6e8384ad54041acfc',
        pluginId: 'audit-fixture',
        pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
    },
    env: testAuditEnvironment(root),
    deps: withTestSandbox({
      prepareArtifact: async () => ({ pluginRoot, cleanup: async () => {} }),
      restartRuntime: async () => { commands.push('restart'); return { ok: true } },
      runCommand: async ({ step }) => {
        commands.push(step)
        if (step === 'validator') return successfulCommandResult('{"valid":true,"errors":[]}')
        if (step === 'inspector') return successfulCommandResult('{"report":{"summary":{"breakageCount":0}}}')
        if (step === 'runtime-inspect') {
          return successfulCommandResult('{"plugin":{"id":"audit-fixture","status":"loaded","toolNames":[]}}')
        }
        return successfulCommandResult('{}')
      },
    }),
  })

  assert.deepEqual(commands, [
    'builder',
    'validator',
    'inspector',
    'install',
    'enable',
    'restart',
    'runtime-inspect',
    'disable',
    'uninstall',
  ])
  assert.equal(report.capabilities.artifacts[0].declared.includes('fixture_read'), true)
  assert.deepEqual(report.capabilities.artifacts[0].runtimeRegistered, [])
  assert.equal(report.capabilities.artifacts[0].runtimeVerified, false)
  assert.equal(report.errors.some(({ code }) => code === 'runtime_registration_unverified'), true)
})

test('release matrix requires every declared tool to appear in runtime inspection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-partial-runtime-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'), { tools: ['fixture_read', 'fixture_status'] })
  const artifact = join(root, 'fixture.tgz')
  await writeFile(artifact, 'fixture archive')
  const commands = []

  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    baseDir: root,
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: 'partial-fixture',
        artifact: 'fixture.tgz',
        sha256: 'f8b1f712f078009f786ea23ebe0a2b14498c80f454453ed6e8384ad54041acfc',
        pluginId: 'audit-fixture',
        pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
    },
    env: testAuditEnvironment(root),
    deps: withTestSandbox({
      prepareArtifact: async () => ({ pluginRoot, cleanup: async () => {} }),
      runCommand: async ({ step }) => {
        commands.push(step)
        if (step === 'validator') return successfulCommandResult('{"valid":true,"errors":[]}')
        if (step === 'runtime-inspect') {
          return successfulCommandResult('{"plugin":{"id":"audit-fixture","status":"loaded","toolNames":["fixture_read"]}}')
        }
        return successfulCommandResult('{}')
      },
    }),
  })

  assert.equal(report.capabilities.artifacts[0].runtimeVerified, false)
  assert.equal(report.errors.some(({ code }) => code === 'runtime_registration_unverified'), true)
  assert.equal(commands.includes('invoke'), false)
})

test('release matrix refuses to invoke a tool not declared read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-write-probe-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'))
  const manifestPath = join(pluginRoot, 'openclaw.plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.toolMetadata.fixture_read.sideEffecting = true
  await writeFile(manifestPath, JSON.stringify(manifest))
  const artifact = join(root, 'fixture.tgz')
  await writeFile(artifact, 'fixture archive')
  const commands = []

  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    baseDir: root,
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: 'write-fixture',
        artifact: 'fixture.tgz',
        sha256: 'f8b1f712f078009f786ea23ebe0a2b14498c80f454453ed6e8384ad54041acfc',
        pluginId: 'audit-fixture',
        pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
    },
    env: testAuditEnvironment(root),
    deps: withTestSandbox({
      prepareArtifact: async () => ({ pluginRoot, cleanup: async () => {} }),
      runCommand: async ({ step }) => {
        commands.push(step)
        if (step === 'validator') return successfulCommandResult('{"valid":true,"errors":[]}')
        if (step === 'runtime-inspect') {
          return successfulCommandResult('{"plugin":{"id":"audit-fixture","status":"loaded","toolNames":["fixture_read"]}}')
        }
        return successfulCommandResult('{}')
      },
    }),
  })

  assert.equal(report.errors.some(({ code }) => code === 'read_only_tool_unverified'), true)
  assert.equal(commands.includes('invoke'), false)
})

test('release matrix treats a missing entitled artifact as a hard failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-missing-'))
  const commands = []

  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    baseDir: root,
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: 'missing-fixture',
        artifact: 'missing.tgz',
        sha256: '0'.repeat(64),
        pluginId: 'audit-fixture',
        pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    runtime: { version: '2026.8.1' },
    deps: withTestSandbox({
      runCommand: async ({ step }) => {
        commands.push(step)
        return successfulCommandResult()
      },
    }),
  })

  assert.equal(report.ok, false)
  assert.deepEqual(report.errors.map(({ code }) => code), ['artifact_missing'])
  assert.deepEqual(commands, [])
})

test('release audit archives its sanitized fail-closed report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-report-'))
  const reportPath = join(root, 'release-artifacts', 'plugin-audit-report.json')
  const { auditPluginRelease } = await loadAuditModule()
  const report = await auditPluginRelease({
    matrixPath: join(root, 'missing-matrix.json'),
    runtimeArchivePath: join(root, 'missing-runtime.tar.gz'),
    reportPath,
  })

  assert.equal(report.ok, false)
  assert.deepEqual(report.errors.map(({ code }) => code), ['artifact_missing'])
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report)
  const json = JSON.stringify(report)
  assert.equal(json.includes(root), false)
  assert.equal(json.includes('OpenClaw'), false)
})

test('canonical attestation encoding sorts every object key', async () => {
  const { canonicalJson } = await loadAuditModule()
  assert.equal(
    canonicalJson({ z: 1, a: { d: true, c: ['x', { b: 2, a: null }] } }),
    '{"a":{"c":["x",{"a":null,"b":2}],"d":true},"z":1}',
  )
})

test('release attestation binds the complete sorted matrix and canonical signature', async () => {
  const matrix = {
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: [
      {
        id: 'artifact-a', artifact: 'a.tgz', sha256: sha256('artifact a'),
        pluginId: 'plugin-a', pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'artifact-a_read', arguments: {} },
      },
      {
        id: 'artifact-b', artifact: 'b.tgz', sha256: sha256('artifact b'),
        pluginId: 'plugin-b', pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'artifact-b_read', arguments: {} },
      },
    ],
  }
  const runtimeSha256 = sha256('trusted runtime')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { envelope, payload } = releaseEnvelopeFixture({ matrix, privateKey, runtimeSha256 })
  const context = {
    matrix,
    artifactSha256ById: Object.fromEntries(matrix.artifacts.map((item) => [item.id, item.sha256])),
    executionRuntimeArchiveSha256: runtimeSha256,
    packageRuntimeArchiveSha256: runtimeSha256,
    packageTarget: 'linux/x64',
    env: releaseVerifierEnv(publicKey),
    now: new Date('2026-09-10T00:30:00.000Z'),
    workerLock: testWorkerLock,
  }
  const resign = (candidate) => ({
    ...envelope,
    payload: candidate,
    signature: sign(null, Buffer.from(testCanonicalJson(candidate)), privateKey).toString('base64'),
  })

  const { verifyAuditAttestation } = await loadAuditModule()
  assert.deepEqual(verifyAuditAttestation({ envelope, ...context }), payload)
  assert.equal(verifyAuditAttestation({
    envelope: resign({ ...payload, artifacts: payload.artifacts.slice(0, 1), matrix: { ...payload.matrix, artifactCount: 1 } }),
    ...context,
  }), null, 'omitted artifact')
  assert.equal(verifyAuditAttestation({
    envelope,
    ...context,
    matrix: { ...matrix, artifacts: [...matrix.artifacts].reverse() },
  }), null, 'reordered matrix')
  assert.equal(verifyAuditAttestation({
    envelope,
    ...context,
    matrix: { ...matrix, artifacts: [...matrix.artifacts, { ...matrix.artifacts[1] }] },
  }), null, 'duplicate artifact')
  assert.equal(verifyAuditAttestation({
    envelope: { ...envelope, signature: `${envelope.signature}\n` },
    ...context,
  }), null, 'non-canonical base64 signature')
  assert.equal(verifyAuditAttestation({
    envelope,
    ...context,
    workerLock: {
      ...testWorkerLock,
      workers: [
        { platform: 'linux/amd64', status: 'available', image: `registry.example/uniopc/other@sha256:${'e'.repeat(64)}` },
        { platform: 'linux/arm64', status: 'unavailable', image: null },
      ],
    },
  }), null, 'worker image outside trusted lock')
})

test('schema-3 attestation binds distinct execution and package runtimes', async () => {
  const matrix = {
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: [{
      id: 'artifact-a', artifact: 'a.tgz', sha256: sha256('artifact a'),
      pluginId: 'plugin-a', pluginApi: '>=2026.8.1',
      readOnlyTool: { name: 'artifact-a_read', arguments: {} },
    }],
  }
  const executionRuntimeArchiveSha256 = sha256('linux execution runtime')
  const packageRuntimeArchiveSha256 = sha256('windows package runtime')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { envelope, payload } = schema3ReleaseEnvelopeFixture({
    matrix,
    privateKey,
    executionRuntimeSha256: executionRuntimeArchiveSha256,
    packageRuntimeSha256: packageRuntimeArchiveSha256,
  })
  const context = {
    matrix,
    artifactSha256ById: { 'artifact-a': matrix.artifacts[0].sha256 },
    executionRuntimeArchiveSha256,
    packageRuntimeArchiveSha256,
    packageTarget: 'win32/x64',
    env: { ...releaseVerifierEnv(publicKey), UNIOPC_PLUGIN_AUDIT_TARGET: 'win32/x64' },
    now: new Date('2026-09-10T00:30:00.000Z'),
    workerLock: testWorkerLock,
  }
  const { verifyAuditAttestation } = await loadAuditModule()
  assert.deepEqual(verifyAuditAttestation({ envelope, ...context }), payload)
  assert.equal(verifyAuditAttestation({ envelope, ...context, packageRuntimeArchiveSha256: sha256('swapped package runtime') }), null)
  assert.equal(verifyAuditAttestation({ envelope, ...context, packageTarget: 'linux/x64' }), null)
  assert.equal(verifyAuditAttestation({ envelope: { ...envelope, schemaVersion: 2 }, ...context }), null)
})

test('schema-3 attestation binds an arm64 execution archive to the arm64 worker', async () => {
  const matrix = {
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: [{
      id: 'artifact-a', artifact: 'a.tgz', sha256: sha256('artifact a'),
      pluginId: 'plugin-a', pluginApi: '>=2026.8.1',
      readOnlyTool: { name: 'artifact-a_read', arguments: {} },
    }],
  }
  const executionRuntimeArchiveSha256 = sha256('linux arm64 execution runtime')
  const packageRuntimeArchiveSha256 = sha256('darwin arm64 package runtime')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { envelope, payload } = schema3ReleaseEnvelopeFixture({
    matrix, privateKey, executionRuntimeSha256: executionRuntimeArchiveSha256, packageRuntimeSha256: packageRuntimeArchiveSha256, packageTarget: 'darwin/arm64',
  })
  payload.executionRuntime.platform = 'linux/arm64'
  payload.sandbox.platform = 'linux/arm64'
  envelope.payload = payload
  envelope.signature = sign(null, Buffer.from(testCanonicalJson(payload)), privateKey).toString('base64')
  const arm64WorkerLock = {
    ...testWorkerLock,
    workers: [
      { platform: 'linux/amd64', status: 'unavailable', image: null },
      { platform: 'linux/arm64', status: 'available', image: testWorkerImage },
    ],
  }
  const context = {
    matrix,
    artifactSha256ById: { 'artifact-a': matrix.artifacts[0].sha256 },
    executionRuntimeArchiveSha256,
    packageRuntimeArchiveSha256,
    packageTarget: 'darwin/arm64',
    env: { ...releaseVerifierEnv(publicKey), UNIOPC_PLUGIN_AUDIT_TARGET: 'darwin/arm64' },
    now: new Date('2026-09-10T00:30:00.000Z'),
    workerLock: arm64WorkerLock,
  }
  const { verifyAuditAttestation } = await loadAuditModule()
  assert.deepEqual(verifyAuditAttestation({ envelope, ...context }), payload)
  const crossArchitecture = structuredClone(payload)
  crossArchitecture.executionRuntime.platform = 'linux/x64'
  const crossEnvelope = {
    ...envelope,
    payload: crossArchitecture,
    signature: sign(null, Buffer.from(testCanonicalJson(crossArchitecture)), privateKey).toString('base64'),
  }
  assert.equal(verifyAuditAttestation({ envelope: crossEnvelope, ...context }), null)
})

test('release audit rejects a Linux execution archive SHA substituted into the native package runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-package-runtime-substitution-'))
  const artifactPath = join(root, 'fixture.tgz')
  const executionRuntimePath = join(root, 'linux-execution-runtime.tar.gz')
  const packageRuntimePath = join(root, 'windows-package-runtime.tar.gz')
  const matrixPath = join(root, 'plugin-release-matrix.json')
  const attestationPath = join(root, 'release.attestation.json')
  const reportPath = join(root, 'report.json')
  const consumptionDirectory = join(root, 'consumed')
  await writeFile(artifactPath, 'trusted artifact')
  await writeFile(executionRuntimePath, 'Linux execution runtime bytes')
  await writeFile(packageRuntimePath, 'Windows package runtime bytes')
  const matrix = {
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: [{
      id: 'package-runtime-fixture',
      artifact: 'fixture.tgz',
      sha256: sha256('trusted artifact'),
      pluginId: 'audit-fixture',
      pluginApi: '>=2026.8.1',
      readOnlyTool: { name: 'package-runtime-fixture_read', arguments: {} },
    }],
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { envelope } = schema3ReleaseEnvelopeFixture({
    matrix,
    privateKey,
    executionRuntimeSha256: sha256('Linux execution runtime bytes'),
    // Deliberately wrong: the signed native-package slot contains the Linux
    // worker archive hash rather than the Windows archive hash.
    packageRuntimeSha256: sha256('Linux execution runtime bytes'),
    packageTarget: 'win32/x64',
  })
  await writeFile(matrixPath, JSON.stringify(matrix))
  await writeFile(attestationPath, JSON.stringify(envelope))
  let pluginExecutionAttempted = false
  const { auditPluginRelease } = await loadAuditModule()
  const report = await auditPluginRelease({
    matrixPath,
    executionRuntimeArchivePath: executionRuntimePath,
    packageRuntimeArchivePath: packageRuntimePath,
    packageTarget: 'win32/x64',
    reportPath,
    env: {
      ...releaseVerifierEnv(publicKey, consumptionDirectory),
      UNIOPC_PLUGIN_AUDIT_TARGET: 'win32/x64',
    },
    deps: {
      now: () => new Date('2026-09-10T00:30:00.000Z'),
      workerLock: testWorkerLock,
      runCommand: async () => { pluginExecutionAttempted = true; throw new Error('must not execute plugin code') },
    },
  })

  assert.equal(pluginExecutionAttempted, false)
  assert.equal(report.ok, false)
  assert.deepEqual(report.errors.map(({ code }) => code), ['attestation_invalid'])
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report)
})

test('release audit atomically consumes one complete envelope and rejects its replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-envelope-replay-'))
  const runtimeArchive = join(root, 'runtime.tar.gz')
  const packageRuntimeArchive = join(root, 'package-runtime.tar.gz')
  const matrixPath = join(root, 'plugin-release-matrix.json')
  const attestationPath = join(root, 'release.attestation.json')
  const ledgerDirectory = join(root, 'consumed-nonces')
  await writeFile(join(root, 'a.tgz'), 'artifact a')
  await writeFile(join(root, 'b.tgz'), 'artifact b')
  await writeFile(runtimeArchive, 'trusted runtime')
  await writeFile(packageRuntimeArchive, 'trusted package runtime')
  const matrix = {
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: [
      {
        id: 'artifact-a', artifact: 'a.tgz', sha256: sha256('artifact a'),
        pluginId: 'plugin-a', pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'artifact-a_read', arguments: {} },
      },
      {
        id: 'artifact-b', artifact: 'b.tgz', sha256: sha256('artifact b'),
        pluginId: 'plugin-b', pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'artifact-b_read', arguments: {} },
      },
    ],
  }
  await writeFile(matrixPath, JSON.stringify(matrix))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { envelope } = releaseEnvelopeFixture({
    matrix,
    privateKey,
    runtimeSha256: sha256('trusted runtime'),
    packageRuntimeSha256: sha256('trusted package runtime'),
  })
  await writeFile(attestationPath, JSON.stringify(envelope))
  const env = releaseVerifierEnv(publicKey, ledgerDirectory)
  const { auditPluginRelease } = await loadAuditModule()
  const results = await Promise.all(['first', 'second'].map((name) => auditPluginRelease({
    matrixPath,
    executionRuntimeArchivePath: runtimeArchive,
    packageRuntimeArchivePath: packageRuntimeArchive,
    packageTarget: 'linux/x64',
    reportPath: join(root, `${name}-report.json`),
    env,
    deps: { now: () => new Date('2026-09-10T00:30:00.000Z'), workerLock: testWorkerLock },
  })))
  assert.deepEqual(results.map((report) => report.ok).sort(), [false, true])
  const replay = results.find((report) => !report.ok)
  assert.deepEqual(replay.errors.map(({ code }) => code), ['attestation_replayed'])
})

test('attestation verifier rejects every release binding and cleanup tamper', async () => {
  const matrix = {
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: [{
      id: 'attested-fixture', artifact: 'fixture.tgz', sha256: sha256('trusted artifact'),
      pluginId: 'audit-fixture', pluginApi: '>=2026.8.1',
      readOnlyTool: { name: 'attested-fixture_read', arguments: {} },
    }],
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { envelope, payload } = releaseEnvelopeFixture({
    matrix,
    privateKey,
    runtimeSha256: sha256('trusted runtime'),
    packageRuntimeSha256: sha256('trusted package runtime'),
  })
  const env = releaseVerifierEnv(publicKey)
  const signEnvelope = (candidate, envelopeExtra = {}) => ({
    schemaVersion: 3,
    keyId: 'audit-key-2026',
    payload: candidate,
    signature: sign(null, Buffer.from(testCanonicalJson(candidate)), privateKey).toString('base64'),
    ...envelopeExtra,
  })
  const context = {
    matrix,
    artifactSha256ById: { 'attested-fixture': sha256('trusted artifact') },
    executionRuntimeArchiveSha256: payload.executionRuntime.archiveSha256,
    packageRuntimeArchiveSha256: payload.packageRuntime.archiveSha256,
    packageTarget: 'linux/x64',
    env,
    now: new Date('2026-09-10T00:30:00.000Z'),
    workerLock: testWorkerLock,
  }
  const tamperCases = [
    ['unknown envelope field', (candidate) => signEnvelope(candidate, { unexpected: true })],
    ['unknown payload field', (candidate) => signEnvelope({ ...candidate, unexpected: true })],
    ['release nonce', (candidate) => signEnvelope({ ...candidate, release: { ...candidate.release, nonce: Buffer.alloc(32, 8).toString('base64') } })],
    ['release commit', (candidate) => signEnvelope({ ...candidate, release: { ...candidate.release, commit: 'e'.repeat(40) } })],
    ['release target', (candidate) => signEnvelope({ ...candidate, release: { ...candidate.release, target: 'linux/arm64' } })],
    ['release run', (candidate) => signEnvelope({ ...candidate, release: { ...candidate.release, runId: 'other-run' } })],
    ['expired proof', (candidate) => signEnvelope({ ...candidate, release: { ...candidate.release, expiresAt: '2026-09-10T00:10:00.000Z' } })],
    ['artifact identity', (candidate) => signEnvelope({ ...candidate, artifacts: [{ ...candidate.artifacts[0], artifactId: 'other' }] })],
    ['plugin API', (candidate) => signEnvelope({ ...candidate, artifacts: [{ ...candidate.artifacts[0], pluginApi: '>=1.0.0' }] })],
    ['runtime version', (candidate) => signEnvelope({ ...candidate, executionRuntime: { ...candidate.executionRuntime, openclawVersion: '2026.8.0' } })],
    ['node version', (candidate) => signEnvelope({ ...candidate, executionRuntime: { ...candidate.executionRuntime, nodeVersion: '24.18.0' } })],
    ['inspector version', (candidate) => signEnvelope({ ...candidate, executionRuntime: { ...candidate.executionRuntime, inspectorVersion: '0.3.23' } })],
    ['runtime archive', (candidate) => signEnvelope({ ...candidate, executionRuntime: { ...candidate.executionRuntime, archiveSha256: sha256('other') } })],
    ['capability hash', (candidate) => signEnvelope({ ...candidate, artifacts: [{ ...candidate.artifacts[0], capabilities: { ...candidate.artifacts[0].capabilities, hash: sha256('other') } }] })],
    ['cleanup proof', (candidate) => signEnvelope({ ...candidate, artifacts: [{ ...candidate.artifacts[0], proof: { ...candidate.artifacts[0].proof, cleaned: false } }] })],
    ['sandbox proof', (candidate) => signEnvelope({ ...candidate, sandbox: { ...candidate.sandbox, enforced: false } })],
    ['worker image', (candidate) => signEnvelope({ ...candidate, sandbox: { ...candidate.sandbox, image: `registry.example/uniopc/other@sha256:${'e'.repeat(64)}` } })],
    ['worker platform', (candidate) => signEnvelope({ ...candidate, sandbox: { ...candidate.sandbox, platform: 'linux/arm64' } })],
    ['worker protocol', (candidate) => signEnvelope({ ...candidate, sandbox: { ...candidate.sandbox, protocol: { ...candidate.sandbox.protocol, version: 2 } } })],
    ['signature', (candidate) => ({ ...signEnvelope(candidate), signature: Buffer.alloc(64).toString('base64') })],
  ]

  const { verifyAuditAttestation } = await loadAuditModule()
  assert.deepEqual(verifyAuditAttestation({ envelope, ...context }), payload)
  for (const [name, createEnvelope] of tamperCases) {
    assert.equal(
      verifyAuditAttestation({ envelope: createEnvelope(structuredClone(payload)), ...context }),
      null,
      name,
    )
  }
  assert.equal(verifyAuditAttestation({
    envelope,
    ...context,
    matrix: {
      ...matrix,
      artifacts: [{ ...matrix.artifacts[0], readOnlyTool: { name: 'attested-fixture_read', arguments: { changed: true } } }],
    },
  }), null, 'read-only invocation arguments')
})

test('release audit verifies a signed artifact-bound attestation without executing plugin code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-attestation-'))
  const artifact = join(root, 'fixture.tgz')
  const runtimeArchive = join(root, 'runtime.tar.gz')
  const packageRuntimeArchive = join(root, 'package-runtime.tar.gz')
  const attestationPath = join(root, 'release.attestation.json')
  const matrixPath = join(root, 'plugin-release-matrix.json')
  const reportPath = join(root, 'report.json')
  await writeFile(artifact, 'trusted artifact')
  await writeFile(runtimeArchive, 'trusted runtime')
  await writeFile(packageRuntimeArchive, 'trusted package runtime')
  const matrix = {
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: [{
      id: 'attested-fixture',
      artifact: 'fixture.tgz',
      sha256: sha256('trusted artifact'),
      pluginId: 'audit-fixture',
      pluginApi: '>=2026.8.1',
      readOnlyTool: { name: 'attested-fixture_read', arguments: {} },
    }],
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { envelope } = releaseEnvelopeFixture({
    matrix,
    privateKey,
    runtimeSha256: sha256('trusted runtime'),
    packageRuntimeSha256: sha256('trusted package runtime'),
  })
  await writeFile(attestationPath, JSON.stringify(envelope))
  await writeFile(matrixPath, JSON.stringify(matrix))
  let executed = false
  const { auditPluginRelease } = await loadAuditModule()
  const report = await auditPluginRelease({
    matrixPath,
    executionRuntimeArchivePath: runtimeArchive,
    packageRuntimeArchivePath: packageRuntimeArchive,
    packageTarget: 'linux/x64',
    reportPath,
    env: releaseVerifierEnv(publicKey, join(root, 'consumed')),
    deps: {
      now: () => new Date('2026-09-10T00:30:00.000Z'),
      workerLock: testWorkerLock,
      runCommand: async () => { executed = true; throw new Error('plugin execution forbidden') },
    },
  })

  assert.equal(executed, false)
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.releaseMatrix.artifacts[0].readOnlyInvoked, true)
  assert.equal(report.capabilities.artifacts[0].runtimeVerified, true)
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report)
})

test('release audit rejects expired, replayed, and non-canonical attestation fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-attestation-invalid-'))
  const artifact = join(root, 'fixture.tgz')
  const runtimeArchive = join(root, 'runtime.tar.gz')
  const packageRuntimeArchive = join(root, 'package-runtime.tar.gz')
  const matrixPath = join(root, 'plugin-release-matrix.json')
  await writeFile(artifact, 'trusted artifact')
  await writeFile(runtimeArchive, 'trusted runtime')
  await writeFile(packageRuntimeArchive, 'trusted package runtime')
  await writeFile(join(root, 'fixture.attestation.json'), JSON.stringify({
    schemaVersion: 2,
    keyId: 'audit-key-2026',
    payload: {
      schemaVersion: 1,
      releaseId: 'old-release',
      issuedAt: '2026-09-09T00:00:00.000Z',
      expiresAt: '2026-09-09T01:00:00.000Z',
      unexpected: true,
    },
    signature: 'invalid',
  }))
  await writeFile(matrixPath, JSON.stringify({
    schemaVersion: 1,
    attestation: 'fixture.attestation.json',
    artifacts: [{
      id: 'attested-fixture', artifact: 'fixture.tgz',
      sha256: sha256('trusted artifact'), pluginId: 'audit-fixture', pluginApi: '>=2026.8.1',
      readOnlyTool: { name: 'fixture_read', arguments: {} },
    }],
  }))
  const { auditPluginRelease } = await loadAuditModule()
  const report = await auditPluginRelease({
    matrixPath,
    executionRuntimeArchivePath: runtimeArchive,
    packageRuntimeArchivePath: packageRuntimeArchive,
    packageTarget: 'linux/x64',
    reportPath: join(root, 'report.json'),
    env: {
      ...releaseVerifierEnv(generateKeyPairSync('ed25519').publicKey, join(root, 'consumed')),
      UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY: 'not-a-key',
    },
    deps: { now: () => new Date('2026-09-10T00:30:00.000Z') },
  })
  assert.equal(report.ok, false)
  assert.deepEqual(report.errors.map(({ code }) => code), ['attestation_invalid'])
})

test('release audit rejects cross-platform aliases that name the same artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-path-aliases-'))
  const runtimeArchive = join(root, 'runtime.tar.gz')
  const matrixPath = join(root, 'plugin-release-matrix.json')
  const nested = join(root, 'nested')
  await mkdir(nested)
  await writeFile(join(root, 'fixture.tgz'), 'fixture')
  await writeFile(join(root, 'Fixture.tgz'), 'fixture')
  await writeFile(join(nested, 'fixture.tgz'), 'fixture')
  await writeFile(runtimeArchive, 'runtime')
  const { publicKey } = generateKeyPairSync('ed25519')
  const { auditPluginRelease } = await loadAuditModule()
  const aliases = [
    ['fixture.tgz', './fixture.tgz'],
    ['Fixture.tgz', 'fixture.tgz'],
    ['nested/fixture.tgz', 'nested\\fixture.tgz'],
  ]
  for (const [aliasIndex, [first, second]] of aliases.entries()) {
    const artifacts = [first, second].map((artifact, index) => ({
      id: `artifact-${index + 1}`,
      artifact,
      sha256: sha256('fixture'),
      pluginId: `plugin-${index + 1}`,
      pluginApi: '>=2026.8.1',
      readOnlyTool: { name: `fixture_read_${index + 1}`, arguments: {} },
    }))
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      attestation: 'release.attestation.json',
      artifacts,
    }))
    const report = await auditPluginRelease({
      matrixPath,
      runtimeArchivePath: runtimeArchive,
      reportPath: join(root, `report-alias-${aliasIndex}.json`),
      env: releaseVerifierEnv(publicKey, join(root, 'consumed')),
    })
    assert.deepEqual(report.errors.map(({ code }) => code), ['matrix_invalid'], `${first} <> ${second}`)
  }
})

test('release audit rejects Windows-reserved and trailing-dot artifact paths on every host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-portable-paths-'))
  const runtimeArchive = join(root, 'runtime.tar.gz')
  const matrixPath = join(root, 'plugin-release-matrix.json')
  await writeFile(runtimeArchive, 'runtime')
  const { publicKey } = generateKeyPairSync('ed25519')
  const { auditPluginRelease } = await loadAuditModule()
  for (const [index, artifact] of ['CON.tgz', 'fixture.tgz.', 'fixture.tgz '].entries()) {
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      attestation: 'release.attestation.json',
      artifacts: [{
        id: 'artifact-1', artifact, sha256: sha256('fixture'),
        pluginId: 'plugin-1', pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    }))
    const report = await auditPluginRelease({
      matrixPath,
      runtimeArchivePath: runtimeArchive,
      reportPath: join(root, `report-unsafe-${index}.json`),
      env: releaseVerifierEnv(publicKey, join(root, 'consumed')),
    })
    assert.deepEqual(report.errors.map(({ code }) => code), ['matrix_invalid'], artifact)
  }
})

test('release audit rejects distinct matrix paths backed by one file identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-hardlink-alias-'))
  const runtimeArchive = join(root, 'runtime.tar.gz')
  const matrixPath = join(root, 'plugin-release-matrix.json')
  await writeFile(join(root, 'artifact-a.tgz'), 'fixture')
  await link(join(root, 'artifact-a.tgz'), join(root, 'artifact-b.tgz'))
  await writeFile(runtimeArchive, 'runtime')
  await writeFile(matrixPath, JSON.stringify({
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: ['a', 'b'].map((suffix, index) => ({
      id: `artifact-${suffix}`,
      artifact: `artifact-${suffix}.tgz`,
      sha256: sha256('fixture'),
      pluginId: `plugin-${suffix}`,
      pluginApi: '>=2026.8.1',
      readOnlyTool: { name: `fixture_read_${index + 1}`, arguments: {} },
    })),
  }))
  const { publicKey } = generateKeyPairSync('ed25519')
  const { auditPluginRelease } = await loadAuditModule()
  const report = await auditPluginRelease({
    matrixPath,
    runtimeArchivePath: runtimeArchive,
    reportPath: join(root, 'report.json'),
    env: releaseVerifierEnv(publicKey, join(root, 'consumed')),
  })
  assert.deepEqual(report.errors.map(({ code }) => code), ['matrix_invalid'])
})

test('release matrix cannot execute a detached attacker without an OS sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-no-sandbox-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'))
  const artifact = join(root, 'fixture.tgz')
  await writeFile(artifact, 'fixture archive')
  let invoked = false
  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: 'attacker',
        artifact: 'fixture.tgz',
        sha256: sha256('fixture archive'),
        pluginId: 'audit-fixture',
        pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    baseDir: root,
    runtime: { version: '2026.8.1', nodePath: process.execPath, cliPath: 'cli', packageRoot: '.' },
    env: testAuditEnvironment(root),
    deps: {
      prepareArtifact: async () => ({ pluginRoot, cleanup: async () => {} }),
      runCommand: async () => {
        invoked = true
        spawn(process.execPath, ['-e', [
          "const {spawn}=require('node:child_process')",
          "spawn(process.execPath,['-e','process.exit()'],{detached:true,stdio:'ignore'}).unref()",
        ].join(';')], { detached: true, stdio: 'ignore' }).unref()
        return successfulCommandResult('{}')
      },
    },
  })
  assert.equal(invoked, false)
  assert.equal(report.ok, false)
  assert.deepEqual(report.errors.map(({ code }) => code), ['sandbox_unavailable'])
})

test('release matrix rejects a sandbox that cannot own runtime restart', async () => {
  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    matrix: { schemaVersion: 1, artifacts: [{ id: 'attacker', artifact: 'missing.tgz' }] },
    baseDir: process.cwd(),
    deps: {
      sandbox: {
        enforced: true,
        kind: 'windows-job',
        runCommand: async () => successfulCommandResult('{}'),
        stageArtifact: async () => { throw new Error('must not stage') },
        quiesce: async () => true,
        close: async () => ({ cleaned: true }),
      },
    },
  })
  assert.deepEqual(report.errors.map(({ code }) => code), ['sandbox_unavailable'])
})

test('container worker command enforces immutable isolation and never forwards host secrets', async () => {
  const { buildContainerRunArguments } = await loadAuditModule()
  const image = `registry.example/uniopc/plugin-audit@sha256:${'a'.repeat(64)}`
  const args = buildContainerRunArguments({
    image,
    inputRoot: 'C:\\audit-input',
    target: 'linux/amd64',
  })
  for (const required of [
    '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '128',
    '--memory', '1073741824', '--cpus', '2', '--pull', 'never', image,
  ]) assert.equal(args.includes(required), true, required)
  assert.equal(args.some((value) => /HOME|TOKEN|SECRET|PRIVATE_KEY/i.test(value)), false)
  assert.equal(args.some((value) => value.includes('/audit-input') && value.endsWith(',readonly')), true)
  assert.equal(args.includes('/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=0700,uid=65532,gid=65532'), true)
  assert.equal(args.includes('/audit-work:rw,nosuid,nodev,size=1073741824,mode=0700,uid=65532,gid=65532'), true)
})

test('container input tree is readable but immutable for the non-root worker uid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-container-permissions-'))
  const nested = join(root, 'nested')
  const input = join(nested, 'input.txt')
  await mkdir(nested)
  await writeFile(input, 'permission contract\n')
  const { removeSealedContainerInputTree, sealContainerInputTree } = await loadAuditModule()
  await sealContainerInputTree(root)
  if (process.platform !== 'win32') {
    assert.equal((await stat(root)).mode & 0o777, 0o555)
    assert.equal((await stat(nested)).mode & 0o777, 0o555)
    assert.equal((await stat(input)).mode & 0o777, 0o444)
  }
  await removeSealedContainerInputTree(root)
  assert.equal(existsSync(root), false)
})

test('linux container permission contract reads sealed input and writes worker tmpfs', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux bind-mount permission contract')
  const image = String(process.env.UNIOPC_PLUGIN_AUDIT_PERMISSION_TEST_IMAGE || '').trim()
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) return t.skip('Pinned permission-test image unavailable')
  let engine = null
  for (const candidate of ['docker', 'podman']) {
    try {
      const probe = await runProcess(candidate, ['version', '--format', '{{.Server.Version}}'], { env: process.env })
      if (probe.code === 0 && probe.stdout.trim()) {
        engine = candidate
        break
      }
    } catch {
      // Missing clients and stopped daemons are a local skip, never a host fallback.
    }
  }
  if (!engine) return t.skip('Linux container daemon unavailable')

  const root = await mkdtemp(join(tmpdir(), 'uniopc-container-live-permissions-'))
  await writeFile(join(root, 'input.txt'), 'permission contract\n')
  const { buildContainerRunArguments, sealContainerInputTree } = await loadAuditModule()
  await sealContainerInputTree(root)
  const args = buildContainerRunArguments({ image, inputRoot: root, target: 'linux/amd64' })
  args.push('sh', '-ceu', 'cat /audit-input/input.txt; touch /audit-work/worker-can-write')
  const result = await runProcess(engine, args, { env: process.env })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'permission contract\n')
})

test('container worker probe fails closed without falling back to a host lifecycle', async () => {
  const calls = []
  const { runContainerReleaseAudit } = await loadAuditModule()
  const result = await runContainerReleaseAudit({
    matrixPath: 'matrix.json',
    runtimeArchivePath: 'runtime.tar.gz',
    env: {
      UNIOPC_PLUGIN_AUDIT_WORKER_IMAGE: testWorkerImage,
      UNIOPC_PLUGIN_AUDIT_CONTAINER_ENGINE: 'docker',
    },
    deps: {
      workerLock: testWorkerLock,
      runCommand: async (options) => {
        calls.push(options)
        return { code: 1, stdout: '', stderr: 'engine unavailable' }
      },
    },
  })
  assert.deepEqual(result.errors.map(({ code }) => code), ['sandbox_unavailable'])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['version', '--format', '{{.Server.Version}}'])
})

test('container producer rejects an arbitrary digest before accepting all-true worker output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-container-untrusted-worker-'))
  const artifactPath = join(root, 'fixture.tgz')
  const runtimePath = join(root, 'runtime.tar.gz')
  const matrixPath = join(root, 'plugin-release-matrix.json')
  await writeFile(artifactPath, 'trusted artifact')
  await writeFile(runtimePath, 'trusted runtime')
  const matrix = {
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: [{
      id: 'attested-fixture', artifact: 'fixture.tgz', sha256: sha256('trusted artifact'),
      pluginId: 'audit-fixture', pluginApi: '>=2026.8.1',
      readOnlyTool: { name: 'attested-fixture_read', arguments: {} },
    }],
  }
  await writeFile(matrixPath, JSON.stringify(matrix))
  let calls = 0
  const { runContainerReleaseAudit } = await loadAuditModule()
  const result = await runContainerReleaseAudit({
    matrixPath,
    runtimeArchivePath: runtimePath,
    env: {
      TEMP: root,
      UNIOPC_PLUGIN_AUDIT_WORKER_IMAGE: `registry.example/attacker/worker@sha256:${'b'.repeat(64)}`,
      UNIOPC_PLUGIN_AUDIT_CONTAINER_ENGINE: 'docker',
    },
    deps: {
      workerLock: testWorkerLock,
      runCommand: async (options) => {
        calls += 1
        return options.args[0] === 'version'
          ? { code: 0, stdout: '27.0.0\n', stderr: '' }
          : { code: 0, stdout: JSON.stringify(successfulWorkerReport(matrix)), stderr: '' }
      },
    },
  })
  assert.deepEqual(result.errors.map(({ code }) => code), ['sandbox_unavailable'])
  assert.equal(calls, 0)
})

test('container producer signs only after a complete hardened worker exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-container-producer-'))
  const artifactPath = join(root, 'fixture.tgz')
  const runtimePath = join(root, 'runtime.tar.gz')
  const packageRuntimePath = join(root, 'package-runtime.tar.gz')
  const matrixPath = join(root, 'plugin-release-matrix.json')
  await writeFile(artifactPath, 'trusted artifact')
  await writeFile(runtimePath, 'trusted runtime')
  await writeFile(packageRuntimePath, 'trusted package runtime')
  const matrix = {
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: [{
      id: 'attested-fixture', artifact: 'fixture.tgz', sha256: sha256('trusted artifact'),
      pluginId: 'audit-fixture', pluginApi: '>=2026.8.1',
      readOnlyTool: { name: 'attested-fixture_read', arguments: {} },
    }],
  }
  await writeFile(matrixPath, JSON.stringify(matrix))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyBase64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  const workerReport = successfulWorkerReport(matrix)
  let containerExited = false
  let privateKeyReads = 0
  const env = {
    ...releaseVerifierEnv(publicKey),
    TEMP: root,
    GITHUB_SHA: testReleaseCommit,
    GITHUB_RUN_ID: '4242',
    UNIOPC_PLUGIN_AUDIT_RUN_ID: '4242',
    UNIOPC_PLUGIN_AUDIT_TARGET: 'win32/x64',
    UNIOPC_PLUGIN_AUDIT_CONTAINER_ENGINE: 'docker',
  }
  Object.defineProperty(env, 'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY', {
    enumerable: true,
    get() {
      privateKeyReads += 1
      assert.equal(containerExited, true, 'private key read before sandbox exit')
      return privateKeyBase64
    },
  })
  const calls = []
  const verifiedTargets = []
  const verifiedRuntimeDirectories = []
  const { runContainerReleaseAudit, verifyAuditAttestation } = await loadAuditModule()
  const result = await runContainerReleaseAudit({
    matrixPath,
    executionRuntimeArchivePath: runtimePath,
    packageRuntimeArchivePath: packageRuntimePath,
    packageTarget: 'win32/x64',
    env,
    deps: {
      now: () => new Date('2026-09-10T00:00:00.000Z'),
      workerLock: testWorkerLock,
      verifyRuntimeContract: async (target, options) => {
        verifiedTargets.push(target)
        verifiedRuntimeDirectories.push(options?.runtimeDirectory)
        const execution = target.platform === 'linux'
        return {
          version: '2026.8.1',
          target,
          artifact: { nodeVersion: '24.19.0' },
          verifiedArchive: { sha256: sha256(execution ? 'trusted runtime' : 'trusted package runtime') },
        }
      },
      runCommand: async (options) => {
        calls.push(options)
        if (options.args[0] === 'version') return { code: 0, stdout: '27.0.0\n', stderr: '' }
        assert.equal(options.args.includes('--read-only'), true)
        assert.equal(options.args.includes('--network'), true)
        assert.equal(options.args.includes('none'), true)
        assert.equal(options.args.includes(testWorkerImage), true)
        assert.deepEqual(options.args.slice(-6), [
          '--protocol', testWorkerLock.protocol.id,
          '--protocol-version', String(testWorkerLock.protocol.version),
          '--report-schema-version', String(testWorkerLock.protocol.reportSchemaVersion),
        ])
        assert.equal(options.args.some((value) => value === privateKeyBase64), false)
        containerExited = true
        return { code: 0, stdout: JSON.stringify(workerReport), stderr: '' }
      },
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(calls.length, 2)
  assert.deepEqual(verifiedTargets, [
    { platform: 'linux', arch: 'x64' },
    { platform: 'win32', arch: 'x64' },
  ])
  assert.deepEqual(verifiedRuntimeDirectories, [root, root])
  assert.equal(privateKeyReads, 1)
  assert.match(result.envelope.payload.release.nonce, /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/)
  assert.notEqual(result.envelope.payload.release.nonce, testReleaseNonce)
  assert.deepEqual(JSON.parse(await readFile(join(root, matrix.attestation), 'utf8')), result.envelope)
  assert.deepEqual(verifyAuditAttestation({
    envelope: result.envelope,
    matrix,
    artifactSha256ById: { 'attested-fixture': sha256('trusted artifact') },
    executionRuntimeArchiveSha256: sha256('trusted runtime'),
    packageRuntimeArchiveSha256: sha256('trusted package runtime'),
    packageTarget: 'win32/x64',
    env: {
      ...env,
      UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE: result.envelope.payload.release.nonce,
    },
    now: new Date('2026-09-10T00:30:00.000Z'),
    workerLock: testWorkerLock,
  }), result.envelope.payload)
})

test('staging rejects a sparse artifact larger than 64 MiB before copying it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-oversized-stage-'))
  const artifact = join(root, 'oversized.tgz')
  await writeFile(artifact, '')
  await truncate(artifact, 64 * 1024 * 1024 + 1)
  const { stageImmutableArtifact } = await loadAuditModule()
  await assert.rejects(
    stageImmutableArtifact(artifact, { env: { TEMP: join(root, 'temp'), TMP: join(root, 'temp') } }),
    (error) => error?.code === 'artifact_size_exceeded',
  )
})

test('bounded file snapshots reject symlinked path components', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-input-snapshot-'))
  const targetDirectory = join(root, 'target')
  const linkPath = join(root, 'linked')
  await mkdir(targetDirectory)
  const source = join(targetDirectory, 'source.bin')
  await writeFile(source, Buffer.alloc(128 * 1024, 1))
  await symlink(targetDirectory, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  const { snapshotRegularFile } = await loadAuditModule()
  await assert.rejects(
    snapshotRegularFile(join(linkPath, 'source.bin'), { outputDirectory: join(root, 'out-link') }),
    /artifact_path_invalid/,
  )
})

test('bounded file snapshots reject growth and a path swap at open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-input-races-'))
  const source = join(root, 'source.bin')
  const replacement = join(root, 'replacement.bin')
  await writeFile(source, Buffer.alloc(128 * 1024, 1))
  await writeFile(replacement, Buffer.alloc(128 * 1024, 2))
  const { snapshotRegularFile } = await loadAuditModule()
  await assert.rejects(snapshotRegularFile(source, {
    outputDirectory: join(root, 'out-growth'),
    hooks: { afterFirstChunk: () => appendFile(source, Buffer.from('growth')) },
  }), /artifact_integrity_changed/)
  await assert.rejects(snapshotRegularFile(source, {
    outputDirectory: join(root, 'out-swap'),
    hooks: {
      beforeOpen: async () => {
        await rename(source, join(root, 'original.bin'))
        await rename(replacement, source)
      },
    },
  }), /artifact_integrity_changed/)
})

test('release matrix runs every official gate and records a sanitized successful lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-success-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'))
  const artifact = join(root, 'fixture.tgz')
  await writeFile(artifact, 'fixture archive')
  const commands = []
  const secretMarker = 'PRIVATE_RELEASE_TOKEN'
  const signingSentinel = 'SIGNING_SECRET_MUST_NOT_REACH_PLUGIN'
  let preparedArtifactPath
  let preparedArtifactContents
  let installedArtifactContents
  const realHome = join(root, 'home')
  await mkdir(join(realHome, '.tauri'), { recursive: true })
  await writeFile(join(realHome, '.tauri', 'imai-updater-ci.key'), signingSentinel)

  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    baseDir: root,
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: 'entitled-fixture',
        artifact: 'fixture.tgz',
        sha256: 'f8b1f712f078009f786ea23ebe0a2b14498c80f454453ed6e8384ad54041acfc',
        pluginId: 'audit-fixture',
        pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
      inspectorCliPath: 'node_modules/@openclaw/plugin-inspector/src/cli.js',
    },
    env: {
      PATH: '',
      UNIOPC_PLUGIN_AUDIT_HOME: join(root, 'private-home'),
      UNIOPC_PLUGIN_AUDIT_PROCESS_HOME: realHome,
      UNIOPC_PLUGIN_AUDIT_STATE_DIR: join(root, 'private-state'),
      UNIOPC_PLUGIN_AUDIT_CONFIG_PATH: join(root, 'private-config.json'),
      UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN: secretMarker,
      UNIOPC_PLUGIN_AUDIT_GATEWAY_URL: 'ws://127.0.0.1:12345',
      HOME: realHome,
      TEMP: join(root, 'temp'),
      TMP: join(root, 'temp'),
      TAURI_SIGNING_PRIVATE_KEY: signingSentinel,
      APPLE_API_KEY: signingSentinel,
      GITHUB_TOKEN: signingSentinel,
      CI_JOB_TOKEN: signingSentinel,
    },
    deps: withTestSandbox({
      prepareArtifact: async (candidate) => {
        preparedArtifactPath = candidate
        preparedArtifactContents = await readFile(candidate, 'utf8')
        await writeFile(artifact, 'replacement archive')
        return { pluginRoot, cleanup: async () => {} }
      },
      restartRuntime: async ({ env }) => {
        commands.push({ step: 'restart', args: [], env })
        await assert.rejects(readFile(join(env.HOME, '.tauri', 'imai-updater-ci.key'), 'utf8'))
        return { ok: true }
      },
      runCommand: async ({ step, args, env }) => {
        commands.push({ step, args, env })
        await assert.rejects(readFile(join(env.HOME, '.tauri', 'imai-updater-ci.key'), 'utf8'))
        if (step === 'validator') return successfulCommandResult('{"valid":true,"errors":[]}')
        if (step === 'inspector') return successfulCommandResult('{"report":{"summary":{"breakageCount":0}}}')
        if (step === 'runtime-inspect') {
          return successfulCommandResult('{"plugin":{"id":"audit-fixture","status":"loaded","toolNames":["fixture_read"]}}')
        }
        if (step === 'invoke') return successfulCommandResult('{"ok":true,"output":{"content":[]}}')
        if (step === 'install') installedArtifactContents = await readFile(args[3], 'utf8')
        return { code: 0, stdout: '{}', stderr: `${secretMarker} OpenClaw ${root}` }
      },
    }),
  })

  assert.equal(report.ok, true, JSON.stringify(report))
  assert.deepEqual(commands.map(({ step }) => step), [
    'builder',
    'validator',
    'inspector',
    'install',
    'enable',
    'restart',
    'runtime-inspect',
    'invoke',
    'disable',
    'uninstall',
  ])
  assert.deepEqual(commands[0].args.slice(1), [
    'plugins', 'build', '--root', pluginRoot, '--entry', './dist/index.js', '--check',
  ])
  assert.deepEqual(commands[1].args.slice(1), [
    'plugins', 'validate', '--root', pluginRoot, '--entry', './dist/index.js', '--json',
  ])
  assert.equal(commands[2].args.includes('--openclaw'), true)
  assert.equal(commands[2].args.includes('--runtime'), true)
  assert.equal(commands[2].args.includes('--allow-execute'), true)
  assert.equal(commands[2].args.includes('--check'), true)
  assert.equal(commands.some(({ args }) => args.includes('gateway') && args.includes('restart')), false)
  assert.notEqual(preparedArtifactPath, artifact)
  assert.equal(preparedArtifactContents, 'fixture archive')
  const installCommand = commands.find(({ step }) => step === 'install')
  assert.equal(installCommand.args.includes(preparedArtifactPath), false)
  assert.equal(installedArtifactContents, 'fixture archive')
  const invokeCommand = commands.find(({ step }) => step === 'invoke')
  const invokeParams = JSON.parse(invokeCommand.args[invokeCommand.args.indexOf('--params') + 1])
  assert.deepEqual(invokeParams, {
    name: 'fixture_read',
    args: {},
    sessionKey: 'main',
    confirm: false,
  })
  assert.equal(Object.hasOwn(invokeParams, 'tool'), false)
  for (const command of commands) {
    const serializedEnv = JSON.stringify(command.env)
    assert.equal(serializedEnv.includes(signingSentinel), false, `${command.step} leaked a release secret`)
    assert.equal(command.env.PATH !== undefined, true)
    assert.notEqual(command.env.HOME, realHome)
    assert.equal(command.env.USERPROFILE, command.env.HOME)
    assert.equal(command.env.APPDATA.startsWith(command.env.HOME), true)
    assert.equal(command.env.LOCALAPPDATA.startsWith(command.env.HOME), true)
    assert.equal(command.env.XDG_CONFIG_HOME.startsWith(command.env.HOME), true)
    assert.equal(command.env.XDG_DATA_HOME.startsWith(command.env.HOME), true)
    assert.equal(command.env.HOMEDRIVE + command.env.HOMEPATH, command.env.HOME)
    assert.equal(command.env.TEMP, join(root, 'temp'))
    assert.equal(command.env.XDG_CACHE_HOME !== undefined, true)
  }
  assert.equal(report.capabilities.artifacts[0].runtimeVerified, true)
  assert.equal(report.releaseMatrix.artifacts[0].readOnlyInvoked, true)
  const json = JSON.stringify(report)
  assert.equal(json.includes(secretMarker), false)
  assert.equal(json.includes(root), false)
  assert.equal(json.includes('OpenClaw'), false)
})

test('release matrix propagates command and sandbox cleanup failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-cleanup-proof-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'))
  const artifact = join(root, 'fixture.tgz')
  await writeFile(artifact, 'fixture archive')
  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    baseDir: root,
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: 'cleanup-fixture',
        artifact: 'fixture.tgz',
        sha256: sha256('fixture archive'),
        pluginId: 'audit-fixture',
        pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
    },
    env: testAuditEnvironment(root),
    deps: withTestSandbox({
      prepareArtifact: async () => ({ pluginRoot, cleanup: async () => {} }),
      runCommand: async ({ step }) => {
        if (step === 'validator') return successfulCommandResult('{"valid":true,"errors":[]}')
        if (step === 'runtime-inspect') {
          return successfulCommandResult('{"plugin":{"id":"audit-fixture","status":"loaded","toolNames":["fixture_read"]}}')
        }
        if (step === 'invoke') return successfulCommandResult('{"ok":true,"output":{"content":[]}}')
        if (step === 'disable' || step === 'uninstall') return { ...successfulCommandResult('{}'), cleaned: false }
        return successfulCommandResult('{}')
      },
    }, {
      close: async () => ({ cleaned: false }),
    }),
  })

  assert.equal(report.ok, false)
  assert.equal(report.releaseMatrix.runtimeOwnership.cleaned, false)
  assert.equal(report.releaseMatrix.artifacts[0].disabled, false)
  assert.equal(report.releaseMatrix.artifacts[0].uninstalled, false)
  assert.deepEqual(report.errors.map(({ code }) => code), [
    'lifecycle_disable_failed',
    'lifecycle_uninstall_failed',
  ])
})

test('release matrix stops later plugin commands when cleanup cannot be proven', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-cleanup-stop-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'))
  const artifact = join(root, 'fixture.tgz')
  await writeFile(artifact, 'fixture archive')
  const commands = []
  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    baseDir: root,
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: 'cleanup-stop', artifact: 'fixture.tgz', sha256: sha256('fixture archive'),
        pluginId: 'audit-fixture', pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    runtime: { version: '2026.8.1', nodePath: process.execPath, cliPath: 'cli', packageRoot: root },
    env: testAuditEnvironment(root),
    deps: withTestSandbox({
      prepareArtifact: async () => ({ pluginRoot, cleanup: async () => {} }),
      runCommand: async ({ step }) => {
        commands.push(step)
        return { ...successfulCommandResult('{}'), cleaned: false }
      },
    }),
  })
  assert.equal(report.ok, false)
  assert.deepEqual(commands, ['builder'])
})

test('release matrix refuses install after plugin execution mutates the staged artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-stage-mutation-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'))
  const artifact = join(root, 'fixture.tgz')
  await writeFile(artifact, 'fixture archive')
  let stagedArtifact
  let installedContents
  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    baseDir: root,
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: 'mutation-fixture',
        artifact: 'fixture.tgz',
        sha256: 'f8b1f712f078009f786ea23ebe0a2b14498c80f454453ed6e8384ad54041acfc',
        pluginId: 'audit-fixture',
        pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
    },
    env: {
      PATH: '',
      TEMP: join(root, 'temp'),
      TMP: join(root, 'temp'),
      UNIOPC_PLUGIN_AUDIT_HOME: join(root, 'audit-home'),
      UNIOPC_PLUGIN_AUDIT_STATE_DIR: join(root, 'audit-state'),
      UNIOPC_PLUGIN_AUDIT_CONFIG_PATH: join(root, 'audit-state', 'config.json'),
      UNIOPC_PLUGIN_AUDIT_GATEWAY_URL: 'ws://127.0.0.1:12345',
      UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN: 'audit-token',
    },
    deps: withTestSandbox({
      prepareArtifact: async (candidate) => {
        stagedArtifact = candidate
        return { pluginRoot, cleanup: async () => {} }
      },
      runCommand: async ({ step, args }) => {
        if (step === 'validator') return successfulCommandResult('{"valid":true,"errors":[]}')
        if (step === 'inspector') {
          await writeFile(stagedArtifact, 'replacement archive')
          return successfulCommandResult('{}')
        }
        if (step === 'install') installedContents = await readFile(args[3], 'utf8')
        return successfulCommandResult('{}')
      },
    }),
  })

  assert.equal(installedContents, undefined)
  assert.equal(report.ok, false)
  assert.equal(report.errors.some(({ code }) => code === 'artifact_integrity_changed'), true)
})

test('release matrix waits out delayed plugin descendants before creating its install copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-stage-background-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'))
  const artifact = join(root, 'fixture.tgz')
  await writeFile(artifact, 'fixture archive')
  let stagedArtifact
  let installedContents
  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    baseDir: root,
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: 'background-fixture',
        artifact: 'fixture.tgz',
        sha256: 'f8b1f712f078009f786ea23ebe0a2b14498c80f454453ed6e8384ad54041acfc',
        pluginId: 'audit-fixture',
        pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
    },
    env: {
      PATH: '',
      TEMP: join(root, 'temp'),
      TMP: join(root, 'temp'),
      UNIOPC_PLUGIN_AUDIT_HOME: join(root, 'audit-home'),
      UNIOPC_PLUGIN_AUDIT_STATE_DIR: join(root, 'audit-state'),
      UNIOPC_PLUGIN_AUDIT_CONFIG_PATH: join(root, 'audit-state', 'config.json'),
      UNIOPC_PLUGIN_AUDIT_GATEWAY_URL: 'ws://127.0.0.1:12345',
      UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN: 'audit-token',
    },
    deps: withTestSandbox({
      prepareArtifact: async (candidate) => {
        stagedArtifact = candidate
        return { pluginRoot, cleanup: async () => {} }
      },
      quiescePluginProcesses: async () => new Promise((resolveWait) => setTimeout(resolveWait, 20)),
      runCommand: async ({ step, args }) => {
        if (step === 'validator') return successfulCommandResult('{"valid":true,"errors":[]}')
        if (step === 'inspector') {
          setTimeout(() => { void writeFile(stagedArtifact, 'delayed replacement') }, 0)
          return successfulCommandResult('{}')
        }
        if (step === 'install') {
          await new Promise((resolveWait) => setImmediate(resolveWait))
          installedContents = await readFile(args[3], 'utf8')
        }
        return successfulCommandResult('{}')
      },
    }),
  })

  assert.equal(installedContents, undefined)
  assert.equal(report.errors.some(({ code }) => code === 'artifact_integrity_changed'), true)
})

test('archive preparation rejects multiple plugin roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-multi-root-'))
  const source = join(root, 'source')
  await writePluginFixture(join(source, 'one'))
  await writePluginFixture(join(source, 'two'))
  const artifact = join(root, 'multi-root.tgz')
  await createTarArchive(source, artifact)
  const { defaultPrepareArtifact } = await loadAuditModule()

  await assert.rejects(defaultPrepareArtifact(artifact, { runCommand: ({ command, args, cwd, env }) => (
    runProcess(command, args, { cwd, env })
  ) }), /archive invalid/)
})

test('archive preparation accepts published ZIPs and rejects traversal names', async (t) => {
  if (process.platform === 'win32') return t.skip('zip CLI fixture is available on Unix release workers')
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-zip-'))
  const source = join(root, 'source')
  await writePluginFixture(join(source, 'plugin'))
  const artifact = join(root, 'plugin.zip')
  const result = await runProcess('zip', ['-qr', artifact, 'plugin'], { cwd: source, env: process.env })
  assert.equal(result.code, 0, result.stderr)
  const { defaultPrepareArtifact } = await loadAuditModule()
  const prepared = await defaultPrepareArtifact(artifact)
  assert.equal((await readFile(join(prepared.pluginRoot, 'openclaw.plugin.json'), 'utf8')).includes('audit-fixture'), true)
  await prepared.cleanup()

  const bytes = await readFile(artifact)
  const original = Buffer.from('plugin/dist/index.js')
  const traversal = Buffer.from('plugin/../../evil.js')
  assert.equal(original.length, traversal.length)
  let count = 0
  for (let index = bytes.indexOf(original); index !== -1; index = bytes.indexOf(original, index + original.length)) {
    traversal.copy(bytes, index)
    count += 1
  }
  assert.equal(count, 2)
  const malicious = join(root, 'malicious.zip')
  await writeFile(malicious, bytes)
  await assert.rejects(defaultPrepareArtifact(malicious), /archive invalid/)
})

test('archive preparation rejects hardlink entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-hardlink-'))
  const source = join(root, 'source')
  const pluginRoot = await writePluginFixture(join(source, 'plugin'))
  await link(join(pluginRoot, 'package.json'), join(pluginRoot, 'package-copy.json'))
  const artifact = join(root, 'hardlink.tgz')
  await createTarArchive(source, artifact)
  const { defaultPrepareArtifact } = await loadAuditModule()

  await assert.rejects(defaultPrepareArtifact(artifact, { runCommand: ({ command, args, cwd, env }) => (
    runProcess(command, args, { cwd, env })
  ) }), /archive invalid/)
})

test('archive limits reject links, excessive entries, oversized entries, and compression bombs', async () => {
  const limits = {
    maxCompressedBytes: 1024 * 1024,
    maxEntries: 2,
    maxEntryBytes: 32,
    maxUnpackedBytes: 48,
  }
  const { defaultPrepareArtifact, validateArchiveEntries } = await loadAuditModule()
  assert.equal(validateArchiveEntries([
    { path: 'plugin/package.json', type: 'File', size: 16 },
    { path: 'plugin/link', type: 'SymbolicLink', size: 0 },
  ], limits), false)
  assert.equal(validateArchiveEntries([
    { path: 'one', type: 'File', size: 1 },
    { path: 'two', type: 'File', size: 1 },
    { path: 'three', type: 'File', size: 1 },
  ], limits), false)
  assert.equal(validateArchiveEntries([
    { path: 'large', type: 'File', size: 33 },
  ], limits), false)
  assert.equal(validateArchiveEntries([
    { path: 'one', type: 'File', size: 25 },
    { path: 'two', type: 'File', size: 25 },
  ], limits), false)

  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-size-limit-'))
  const source = join(root, 'source')
  await writePluginFixture(join(source, 'plugin'))
  const artifact = join(root, 'oversized.tgz')
  await createTarArchive(source, artifact)
  await assert.rejects(defaultPrepareArtifact(artifact, {
    limits: {
      maxCompressedBytes: 1,
      maxEntries: 100,
      maxEntryBytes: 1024 * 1024,
      maxUnpackedBytes: 1024 * 1024,
    },
  }), /archive invalid/)
  await assert.rejects(defaultPrepareArtifact(artifact, {
    limits: {
      maxCompressedBytes: 1024 * 1024,
      maxEntries: 100,
      maxEntryBytes: 1024 * 1024,
      maxUnpackedBytes: 64,
    },
  }), /archive invalid/)
})

test('archive entries reject cross-platform path collisions and unsafe Windows names', async () => {
  const { validateArchiveEntries } = await loadAuditModule()
  const file = (path) => ({ path, type: 'File', size: 1 })
  const directory = (path) => ({ path, type: 'Directory', size: 0 })

  assert.equal(validateArchiveEntries([file('plugin/package.json'), file('plugin/PACKAGE.JSON')]), false)
  assert.equal(validateArchiveEntries([file('plugin/entry.js'), file('plugin/entry.js.')]), false)
  assert.equal(validateArchiveEntries([file('plugin\\entry.js'), file('PLUGIN/ENTRY.JS')]), false)
  assert.equal(validateArchiveEntries([file('plugin/dist'), file('plugin/dist/index.js')]), false)
  assert.equal(validateArchiveEntries([file('plugin/dist/index.js'), file('PLUGIN/DIST')]), false)
  assert.equal(validateArchiveEntries([directory('plugin/dist/'), file('plugin/dist')]), false)
  assert.equal(validateArchiveEntries([file('plugin/../escape.js')]), false)
  assert.equal(validateArchiveEntries([file('plugin/CON')]), false)
  assert.equal(validateArchiveEntries([file('plugin/com1.txt')]), false)
  assert.equal(validateArchiveEntries([file('plugin/entry.js:payload')]), false)
  assert.equal(validateArchiveEntries([directory('plugin'), file('plugin/index.js')]), true)
})

test('post-extraction containment rejects a link that resolves outside staging', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-containment-'))
  const extractionRoot = join(root, 'extracted')
  const outside = join(root, 'outside')
  await mkdir(extractionRoot)
  await mkdir(outside)
  try {
    await symlink(outside, join(extractionRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`link creation unavailable: ${error.code}`)
    return
  }
  const { extractionIsContained } = await loadAuditModule()
  assert.equal(await extractionIsContained(extractionRoot, {
    maxEntries: 10,
    maxEntryBytes: 1024,
    maxUnpackedBytes: 1024,
  }), false)
})

test('release matrix sanitizes untrusted descriptor values on command failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-command-redaction-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'))
  const artifact = join(root, 'fixture.tgz')
  await writeFile(artifact, 'fixture archive')
  const marker = 'OpenClaw\\private\\credential'
  const { runReleaseMatrix } = await loadAuditModule()
  const report = await runReleaseMatrix({
    baseDir: root,
    matrix: {
      schemaVersion: 1,
      artifacts: [{
        id: marker,
        artifact: 'fixture.tgz',
        sha256: 'f8b1f712f078009f786ea23ebe0a2b14498c80f454453ed6e8384ad54041acfc',
        pluginId: 'audit-fixture',
        pluginApi: '>=2026.8.1',
        readOnlyTool: { name: 'fixture_read', arguments: {} },
      }],
    },
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
    },
    deps: withTestSandbox({
      prepareArtifact: async () => ({ pluginRoot, cleanup: async () => {} }),
      runCommand: async ({ step }) => step === 'builder'
        ? { code: 1, stdout: marker, stderr: `${root} ${marker}` }
        : successfulCommandResult('{"valid":true,"errors":[]}'),
    }),
  })

  const json = JSON.stringify(report)
  assert.equal(json.includes(marker), false)
  assert.equal(json.includes(root), false)
  assert.equal(json.includes('OpenClaw'), false)
  assert.equal(report.errors.some(({ artifactId }) => artifactId === 'release-artifact'), true)
})

test('artifact audit chains the locked builder, validator, and official inspector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-official-'))
  await writePluginFixture(root)
  const commands = []
  const { auditArtifact } = await loadAuditModule()
  const report = await auditArtifact(root, {
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
      inspectorCliPath: 'node_modules/@openclaw/plugin-inspector/src/cli.js',
    },
    deps: {
      runCommand: async ({ step, args }) => {
        commands.push({ step, args })
        if (step === 'validator') return successfulCommandResult('{"valid":true,"errors":[]}')
        return successfulCommandResult('{}')
      },
    },
  })

  assert.equal(report.ok, true)
  assert.deepEqual(commands.map(({ step }) => step), ['builder', 'validator', 'inspector'])
  assert.deepEqual(report.compatibility.checks, { builder: true, validator: true, inspector: true })
  assert.equal(report.capabilities.runtimeVerified, false)
})

test('single-directory command remains a preflight failure without runtime proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-preflight-'))
  await writePluginFixture(root)
  const { auditTarget } = await loadAuditModule()
  let executed = 0
  const report = await auditTarget(root, {
    env: { PATH: '', TEMP: root, TMP: root },
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
      inspectorCliPath: 'node_modules/@openclaw/plugin-inspector/src/cli.js',
    },
    deps: {
      runCommand: async () => {
        executed += 1
        throw new Error('single-target preflight must never execute candidate-adjacent tooling')
      },
    },
  })

  assert.equal(report.mode, 'preflight')
  assert.equal(report.ok, false)
  assert.equal(executed, 0)
  assert.deepEqual(report.compatibility.artifacts[0].checks, {
    builder: false,
    validator: false,
    inspector: false,
  })
  assert.deepEqual(report.errors.map(({ code }) => code), ['runtime_registration_unverified'])
  assert.equal(report.capabilities.artifacts[0].runtimeVerified, false)
})

test('artifact audit keeps CLI staging on the configured temporary drive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-cache-'))
  await writePluginFixture(root)
  const taskTemp = join(root, 'task-temp')
  const commandEnvironments = []
  const { auditArtifact } = await loadAuditModule()
  await auditArtifact(root, {
    runtime: {
      version: '2026.8.1',
      nodePath: 'node',
      cliPath: 'engine-cli.mjs',
      packageRoot: 'engine-package',
    },
    env: { TEMP: taskTemp, TMP: taskTemp, PATH: '' },
    deps: {
      runCommand: async ({ step, env }) => {
        commandEnvironments.push({ step, env })
        if (step === 'validator') return successfulCommandResult('{"valid":true,"errors":[]}')
        return successfulCommandResult('{}')
      },
    },
  })

  assert.equal(commandEnvironments.length, 3)
  for (const { env } of commandEnvironments) {
    assert.equal(env.XDG_CACHE_HOME.startsWith(taskTemp), true)
    assert.equal(Object.hasOwn(env, 'OPENCLAW_STATE_DIR'), false)
  }
})

test('runtime discovery refuses a CLI outside the exact locked package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-runtime-cli-'))
  const packageRoot = join(root, 'runtime-package')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '2026.8.1' }))
  const outsideCli = join(root, 'other-cli.mjs')
  await writeFile(outsideCli, 'process.stdout.write("OpenClaw 2026.8.1")\n')

  const { runtimeFromEnvironment } = await loadAuditModule()
  const runtime = await runtimeFromEnvironment({
    ...process.env,
    UNIOPC_OPENCLAW_NODE: process.execPath,
    UNIOPC_OPENCLAW_CLI: outsideCli,
    UNIOPC_OPENCLAW_PACKAGE_ROOT: packageRoot,
  })
  assert.equal(runtime, null)
})

test('inspector discovery requires the pinned package CLI entrypoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-inspector-cli-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.3.24' }))
  const alternateCli = join(root, 'src', 'other.js')
  await writeFile(alternateCli, '')

  const { validateInspectorVersion } = await loadAuditModule()
  assert.equal(await validateInspectorVersion(alternateCli), false)
})

test('desktop package exposes the audit command and pins the verified inspector release', async () => {
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts['audit:openclaw-plugins'], 'node scripts/audit-openclaw-plugin.mjs')
  assert.equal(
    packageJson.scripts['produce:openclaw-plugin-attestation'],
    'node scripts/audit-openclaw-plugin.mjs --produce-release-attestation',
  )
  assert.equal(packageJson.devDependencies['@openclaw/plugin-inspector'], '0.3.24')
  assert.equal(existsSync(join(projectRoot, '.npmrc')), false)
})

test('documented silent npm audit entry emits JSON while raw npm run keeps its banner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-plugin-npm-json-'))
  const pluginRoot = await writePluginFixture(join(root, 'plugin'))
  const portableNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const npmCli = existsSync(portableNpmCli) ? portableNpmCli : process.env.npm_execpath
  assert.equal(typeof npmCli, 'string')
  const commandEnv = {
    ...process.env,
    TEMP: root,
    TMP: root,
    npm_config_cache: join(root, 'npm-cache'),
    UNIOPC_OPENCLAW_NODE: '',
    UNIOPC_OPENCLAW_CLI: '',
    UNIOPC_OPENCLAW_PACKAGE_ROOT: '',
    UNIOPC_PLUGIN_INSPECTOR_CLI: '',
  }
  const rawResult = await runProcess(process.execPath, [
    npmCli,
    'run',
    'audit:openclaw-plugins',
    '--',
    join(root, 'missing-artifact'),
  ], {
    cwd: projectRoot,
    env: commandEnv,
  })

  assert.equal(rawResult.code, 1)
  assert.throws(() => JSON.parse(rawResult.stdout))
  assert.match(rawResult.stdout, /> @uniopc\/desktop@.* audit:openclaw-plugins/)

  const missingResult = await runProcess(process.execPath, [
    npmCli,
    '--silent',
    'run',
    'audit:openclaw-plugins',
    '--',
    join(root, 'missing-artifact'),
  ], {
    cwd: projectRoot,
    env: commandEnv,
  })

  assert.equal(missingResult.code, 1)
  const missingReport = JSON.parse(missingResult.stdout)
  assert.deepEqual(missingReport.errors.map(({ code }) => code), ['artifact_missing'])
  assert.equal(missingReport.ok, false)

  const preflightResult = await runProcess(process.execPath, [
    npmCli,
    '--silent',
    'run',
    'audit:openclaw-plugins',
    '--',
    pluginRoot,
  ], { cwd: projectRoot, env: commandEnv })
  assert.equal(preflightResult.code, 1)
  const preflightReport = JSON.parse(preflightResult.stdout)
  assert.equal(preflightReport.mode, 'preflight')
  assert.equal(preflightReport.ok, false)
  assert.equal(preflightReport.capabilities.artifacts[0].runtimeVerified, false)
})


test('static audit accepts branded manifests and still reads legacy plugin artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-audit-manifest-'))
  await writePluginFixture(root)
  const { auditPluginDirectory } = await loadAuditModule()
  const legacy = await auditPluginDirectory(root)
  await rename(join(root, 'openclaw.plugin.json'), join(root, 'uniopc.plugin.json'))
  const branded = await auditPluginDirectory(root)
  assert.deepEqual(branded, legacy)
  assert.equal(branded.ok, true)
})
