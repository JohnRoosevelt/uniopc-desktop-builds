import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { invoke as staticTauriInvoke } from '@tauri-apps/api/core'

import * as tauriE2e from './e2e-tauri.mjs'

const {
  DEFAULT_SMOKE_CASES,
  E2E_TEST_DIMENSIONS,
  buildSummary,
  credentialsFromEnv,
  evaluateSmokeText,
  redactSecrets,
} = tauriE2e

test('credentialsFromEnv reads credentials without exposing secret defaults', () => {
  assert.deepEqual(
    credentialsFromEnv({
      IMAI_E2E_EMAIL: 'tester@example.com',
      IMAI_E2E_PASSWORD: 'secret-password',
    }),
    {
      email: 'tester@example.com',
      password: 'secret-password',
      hasCredentials: true,
    },
  )

  assert.deepEqual(credentialsFromEnv({}), {
    email: '',
    password: '',
    hasCredentials: false,
  })
})

test('Tauri dev launcher uses the npm CLI through Node on Windows', () => {
  assert.equal(typeof tauriE2e.tauriDevCommandForPlatform, 'function')
  if (typeof tauriE2e.tauriDevCommandForPlatform !== 'function') return

  assert.deepEqual(tauriE2e.tauriDevCommandForPlatform({
    platform: 'win32',
    execPath: 'C:\\node\\node.exe',
    env: { npm_execpath: 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js' },
  }), {
    command: 'C:\\node\\node.exe',
    args: [
      'C:\\node\\node_modules\\npm\\bin\\npm-cli.js',
      'run', 'tauri:dev', '--', '--config', 'src-tauri/tauri.e2e.conf.json',
    ],
  })
  assert.deepEqual(tauriE2e.tauriDevCommandForPlatform({ platform: 'linux' }), {
    command: 'npm',
    args: ['run', 'tauri:dev', '--', '--config', 'src-tauri/tauri.e2e.conf.json'],
  })
})

test('bridge and main-window readiness are bounded and observe launcher exit', async () => {
  assert.equal(typeof tauriE2e.connectToBridge, 'function')
  assert.equal(typeof tauriE2e.waitForMainWindow, 'function')

  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  const connecting = tauriE2e.connectToBridge({
    host: '127.0.0.1',
    basePort: 9223,
    scanCount: 1,
    timeoutMs: 500,
    child,
    logger: { write: async () => {} },
    tryConnectFn: async () => new Promise(() => {}),
    sleepFn: async () => {},
  })
  queueMicrotask(() => {
    child.exitCode = 7
    child.emit('exit', 7, null)
  })
  await assert.rejects(connecting, /launcher exited.*7|exited before.*bridge/i)

  const calls = []
  const windowResponses = [[], [{ label: 'main', isMain: true }]]
  const domResponses = [false, true]
  const readyClient = {
    command: async (command, args) => {
      calls.push([command, args])
      return { data: windowResponses.shift() ?? [{ label: 'main', isMain: true }] }
    },
    executeJs: async () => domResponses.shift() ?? true,
  }
  await tauriE2e.waitForMainWindow({
    client: readyClient,
    timeoutMs: 500,
    pollIntervalMs: 0,
    sleepFn: async () => {},
  })
  assert.deepEqual(calls, [
    ['list_windows', {}],
    ['list_windows', {}],
  ])

  const windowChild = new EventEmitter()
  windowChild.exitCode = null
  windowChild.signalCode = null
  const waitingForWindow = tauriE2e.waitForMainWindow({
    client: { command: async () => new Promise(() => {}) },
    child: windowChild,
    timeoutMs: 500,
  })
  queueMicrotask(() => {
    windowChild.exitCode = 9
    windowChild.emit('exit', 9, null)
  })
  await assert.rejects(waitingForWindow, /launcher exited.*9|exited before.*main window/i)

  await assert.rejects(
    tauriE2e.waitForMainWindow({
      client: { command: async () => ({ data: [] }) },
      timeoutMs: 10,
      pollIntervalMs: 1,
    }),
    /timed out waiting for the Tauri main window/i,
  )
})

test('Windows cleanup targets only the runner child PID tree and waits for real exit', async () => {
  assert.equal(typeof tauriE2e.stopProcess, 'function')

  const calls = []
  const child = new EventEmitter()
  child.pid = 4242
  child.killed = true
  child.exitCode = null
  child.signalCode = null
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options })
    const taskkill = new EventEmitter()
    taskkill.exitCode = null
    setImmediate(() => {
      taskkill.exitCode = 0
      taskkill.emit('exit', 0, null)
      setImmediate(() => {
        child.exitCode = 1
        child.emit('exit', 1, null)
      })
    })
    return taskkill
  }

  await tauriE2e.stopProcess(child, { write: async () => {} }, {
    platform: 'win32',
    spawnProcess,
    timeoutMs: 250,
  })

  assert.equal(child.exitCode, 1)
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['taskkill', ['/PID', '4242', '/T', '/F']],
  ])
})

test('redactSecrets removes configured email and password from report text', () => {
  const text = 'login tester@example.com with secret-password then continue'
  assert.equal(
    redactSecrets(text, {
      email: 'tester@example.com',
      password: 'secret-password',
    }),
    'login [redacted-email] with [redacted-password] then continue',
  )
})

test('redactSecrets removes structured authorization, gateway tokens, and fixture prompts', () => {
  const secrets = [
    'bearer-release-secret',
    'basic-release-secret',
    'gateway-release-token',
    'query-release-token',
    'access-release-token',
    'client-release-secret',
    'opaque-prefixed-gateway-value',
    'fixture failure prompt with private marker',
    'fixture workspace prompt with private marker',
  ]
  const text = [
    'Authorization: Bearer bearer-release-secret',
    '{"authorization":"Basic basic-release-secret"}',
    '{"gatewayToken":"gateway-release-token","password":"json-password-secret"}',
    '{"accessToken":"access-release-token","client_secret":"client-release-secret"}',
    'https://example.invalid/probe?token=query-release-token&api_key=query-api-secret',
    'UNIOPC_PLUGIN_AUDIT_GATEWAY_TOKEN=opaque-prefixed-gateway-value',
    'fixture failure prompt with private marker',
    'fixture workspace prompt with private marker',
  ].join('\n')

  const redacted = redactSecrets(text, {
    sensitiveValues: secrets.slice(7),
  })

  for (const secret of [...secrets, 'json-password-secret', 'query-api-secret']) {
    assert.equal(redacted.includes(secret), false, `${secret} leaked`)
  }
  assert.match(redacted, /Authorization: \[redacted-authorization\]/)
  assert.match(redacted, /"gatewayToken":"\[redacted-secret\]"/)
  assert.match(redacted, /token=\[redacted-secret\]/)
  assert.match(redacted, /\[redacted-fixture\]/)
})

test('redactSecrets covers quoted assignments and typed structured secret values without consuming safe fields', () => {
  const stringInput = [
    'accessToken="quoted-access-secret"',
    "client_secret='quoted-client-secret'",
    '{"PREFIX_GATEWAY_TOKEN":123456789,"password":true,"private-key":false}',
    'tokenCount=7',
    'credentialStatus="ready"',
    'ordinary prose about a token budget remains visible',
  ].join('\n')
  const structuredInput = {
    accessToken: 'object-access-secret',
    nested: [
      { client_secret: 'object-client-secret' },
      { PREFIX_GATEWAY_TOKEN: 987654321 },
      { password: true, 'private-key': false },
    ],
    tokenCount: 7,
    credentialStatus: 'ready',
    description: 'ordinary prose about a token budget remains visible',
  }

  const redactedString = redactSecrets(stringInput)
  const redactedObject = redactSecrets(structuredInput)

  for (const leaked of [
    'quoted-access-secret',
    'quoted-client-secret',
    '123456789',
    'object-access-secret',
    'object-client-secret',
    '987654321',
  ]) {
    assert.equal(`${redactedString}\n${redactedObject}`.includes(leaked), false, `${leaked} leaked`)
  }
  assert.match(redactedString, /accessToken="\[redacted-secret\]"/)
  assert.match(redactedString, /client_secret='\[redacted-secret\]'/)
  assert.match(redactedString, /"PREFIX_GATEWAY_TOKEN":"\[redacted-secret\]"/)
  assert.match(redactedObject, /"password": "\[redacted-secret\]"/)
  assert.match(redactedObject, /"private-key": "\[redacted-secret\]"/)
  assert.match(redactedString, /tokenCount=7/)
  assert.match(redactedString, /credentialStatus="ready"/)
  assert.match(redactedObject, /"tokenCount": 7/)
  assert.match(redactedObject, /"credentialStatus": "ready"/)
  assert.match(redactedObject, /ordinary prose about a token budget remains visible/)
})

test('failure invoke monitor captures the real static Tauri invoke path, stays bounded, and preserves rejection', async () => {
  assert.equal(typeof tauriE2e.e2eDomHelpersSource, 'function')

  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const calls = []
  const backendError = new Error('401 unauthorized')
  const backendInvoke = async function (command, args, options) {
    const capturedAtStart = window.__IMAI_E2E__?.failureInvokeEventsAfter(0).at(-1)
    calls.push({ command, args, options, receiver: this, capturedAtStart })
    if (command === 'conversation_send_turn') throw backendError
    return { ok: true }
  }
  const internals = { invoke: backendInvoke }
  globalThis.window = {
    __TAURI_INTERNALS__: internals,
    __TAURI__: { core: { invoke: async () => 'legacy-wrapper-must-not-run' } },
    location: { hash: '' },
  }
  globalThis.document = {}

  try {
    Function(tauriE2e.e2eDomHelpersSource())()
    const helpers = window.__IMAI_E2E__
    assert.equal(helpers.installFailureInvokeMonitor({ maxEvents: 2 }), true)
    assert.equal(helpers.installFailureInvokeMonitor({ maxEvents: 2 }), true)
    const baseline = helpers.failureInvokeBaseline()
    const request = {
      req: {
        profile: 'release-profile',
        sessionKey: 'agent:sales:main',
        input: 'Trigger the configured synthetic authentication failure.',
        idempotencyKey: 'bound-before-failure',
        attachments: [{ content: 'attachment-secret-must-not-be-captured' }],
      },
    }

    await assert.rejects(
      staticTauriInvoke('conversation_send_turn', request, { headers: { trace: 'one' } }),
      error => error === backendError,
    )
    for (const idempotencyKey of ['bounded-two', 'bounded-three']) {
      await assert.rejects(staticTauriInvoke('conversation_send_turn', {
        req: { ...request.req, idempotencyKey },
      }))
    }

    const events = helpers.failureInvokeEventsAfter(baseline)
    assert.equal(events.length, 2)
    assert.deepEqual(events.map(event => event.args.req.idempotencyKey), ['bounded-two', 'bounded-three'])
    assert.equal(events.every(event => event.status === 'rejected'), true)
    assert.equal(events.every(event => event.error === '401 unauthorized'), true)
    assert.equal(JSON.stringify(events).includes('attachment-secret-must-not-be-captured'), false)
    assert.equal(calls[0].capturedAtStart.args.req.idempotencyKey, 'bound-before-failure')
    assert.equal(calls[0].capturedAtStart.status, 'pending')
    assert.equal(calls[0].receiver, internals)
    assert.deepEqual(calls[0].options, { headers: { trace: 'one' } })
    assert.equal(helpers.restoreFailureInvokeMonitor(), true)
    assert.equal(window.__TAURI_INTERNALS__.invoke, backendInvoke)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('default smoke cases cover the main app surface', () => {
  const ids = DEFAULT_SMOKE_CASES.map(item => item.id)

  assert.deepEqual(ids, [
    'app-shell',
    'auth-workspace-bootstrap',
    'conversations',
    'cloud-workbench',
    'cloud-project-flow',
    'cloud-documents',
    'cloud-document-flow',
    'app-center',
    'employees',
    'employees-permissions',
    'plugins',
    'mcp-hub',
    'public-traffic',
    'socials-transcript',
    'socials-leads',
    'socials-tracker',
    'xiaohongshu-home',
    'xiaohongshu-transcript',
    'xiaohongshu-tracker',
    'xiaohongshu-leads',
    'douyin-home',
    'douyin-transcript',
    'douyin-tracker',
    'admin',
    'operations',
    'models',
    'model-provider-settings',
    'openclaw-gateway-readiness',
    'conversation-stream',
    'plugin-mcp-tool-sync',
    'settings',
    'settings-persistence',
    'desktop-release-readiness',
  ])
})

test('default smoke cases cover every end-to-end product dimension', () => {
  const smokeCaseIds = new Set(DEFAULT_SMOKE_CASES.map(item => item.id))
  const dimensions = new Map(E2E_TEST_DIMENSIONS.map(item => [item.id, item]))

  assert.deepEqual([...dimensions.keys()], [
    'app-shell',
    'auth-workspace',
    'local-openclaw-runtime',
    'remote-gateway',
    'conversation',
    'employees-permissions',
    'plugins-mcp',
    'cloud-workbench-documents',
    'app-center-business',
    'models-providers',
    'settings-persistence',
    'security-policy',
    'packaging-update',
  ])

  for (const dimension of dimensions.values()) {
    assert.ok(dimension.label, `${dimension.id} should have a label`)
    assert.ok(dimension.scope.length >= 2, `${dimension.id} should describe concrete scope`)
    assert.ok(dimension.smokeCases.length >= 1, `${dimension.id} should map to smoke cases`)
    for (const smokeCase of dimension.smokeCases) {
      assert.ok(smokeCaseIds.has(smokeCase), `${dimension.id} references missing smoke case ${smokeCase}`)
    }
  }
})

test('buildSummary counts passed and failed cases and keeps artifact paths', () => {
  const summary = buildSummary({
    startedAt: '2026-05-26T00:00:00.000Z',
    finishedAt: '2026-05-26T00:00:03.000Z',
    cases: [
      { id: 'a', status: 'passed', durationMs: 1, screenshot: 'a.png' },
      { id: 'b', status: 'failed', durationMs: 2, error: 'nope', screenshot: 'b.png' },
    ],
    reportDir: 'reports/e2e-tauri/run',
    appStartedByRunner: true,
  })

  assert.equal(summary.total, 2)
  assert.equal(summary.passed, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.status, 'failed')
  assert.equal(summary.artifacts.reportDir, 'reports/e2e-tauri/run')
  assert.equal(summary.appStartedByRunner, true)
})

test('business smoke cases require every critical marker', () => {
  const cases = new Map(DEFAULT_SMOKE_CASES.map(item => [item.id, item]))

  for (const id of ['openclaw-gateway-readiness', 'conversation-stream', 'plugin-mcp-tool-sync']) {
    assert.ok(cases.get(id)?.required?.length >= 2, `${id} should require multiple business markers`)
  }

  assert.equal(
    evaluateSmokeText('OpenClaw Gateway Profile 模型 OpenClaw 版本管理', cases.get('openclaw-gateway-readiness')).ok,
    true,
  )
  assert.equal(
    evaluateSmokeText('OpenClaw Gateway', cases.get('openclaw-gateway-readiness')).ok,
    false,
  )
})

test('release behavior cases bind every OpenClaw 2 proof to executable commands', () => {
  assert.deepEqual(
    tauriE2e.RELEASE_BEHAVIOR_CASES?.map(item => ({ id: item.id, commands: item.commands })),
    [
      { id: 'release-model-identity', commands: ['conversation_load_history'] },
      { id: 'release-session-ownership', commands: ['conversation_list_sessions'] },
      { id: 'release-plugin-catalog', commands: ['openclaw_profile_tool_capabilities_list'] },
      {
        id: 'release-local-workspace-tool',
        commands: [
          'local_document_create',
          'local_documents_list',
          'conversation_send_turn',
          'conversation_load_history',
          'local_document_archive',
        ],
      },
      { id: 'release-truthful-error', commands: ['conversation_send_turn'] },
    ],
  )
})

test('truthful error release behavior requires the profile and session it binds', () => {
  const behavior = tauriE2e.RELEASE_BEHAVIOR_CASES.find(item => item.id === 'release-truthful-error')

  assert.equal(behavior.requiredEnv.includes('IMAI_E2E_PROFILE'), true)
  assert.equal(behavior.requiredEnv.includes('IMAI_E2E_MAIN_SESSION_KEY'), true)
})

test('release behavior fixture reports every missing operator-controlled input', () => {
  assert.equal(typeof tauriE2e.releaseBehaviorFixtureFromEnv, 'function')
  if (typeof tauriE2e.releaseBehaviorFixtureFromEnv !== 'function') return

  const fixture = tauriE2e.releaseBehaviorFixtureFromEnv({
    IMAI_E2E_PROFILE: 'release-profile',
    IMAI_E2E_AGENT_ID: 'sales',
  })

  assert.equal(fixture.configured, false)
  assert.deepEqual(fixture.missing, [
    'IMAI_E2E_MAIN_SESSION_KEY',
    'IMAI_E2E_CRON_SESSION_KEY',
    'IMAI_E2E_EXPECTED_MODEL',
    'IMAI_E2E_EXPECTED_MODEL_LABEL',
    'IMAI_E2E_FAILURE_KIND',
    'IMAI_E2E_FAILURE_PROMPT',
    'IMAI_E2E_FAILURE_EXPECTED_TEXT',
  ])
})

test('release behavior assertions accept independently derived live evidence', () => {
  assert.equal(typeof tauriE2e.evaluateReleaseBehavior, 'function')
  if (typeof tauriE2e.evaluateReleaseBehavior !== 'function') return

  const fixture = {
    profile: 'release-profile',
    agentId: 'sales',
    mainSessionKey: 'agent:sales:main',
    cronSessionKey: 'agent:sales:cron:daily-report',
    expectedModel: 'openai-codex/gpt-5.5',
    expectedModelLabel: '5.5',
    localWorkspacePrompt: 'List the current local document titles.',
    workspaceProofTitle: 'release-document-sentinel',
    localWorkspaceIdempotencyKey: 'e2e-local-workspace-turn',
    failureKind: 'authentication',
    failurePrompt: 'Trigger the configured synthetic authentication failure.',
    failureExpectedText: '模型账号鉴权失败',
    failureIdempotencyKey: 'e2e-failure-bound-turn',
    failureMonitorBaseline: 40,
    failureEventSequence: 41,
  }

  assert.equal(tauriE2e.evaluateReleaseBehavior('release-model-identity', {
    display: {
      route: '/conversations',
      selectedSessionKey: 'agent:sales:main',
      modelLabel: '5.5',
    },
    history: {
      sessionKey: 'agent:sales:main',
      modelProvider: 'openai-codex',
      model: 'gpt-5.5',
      gatewayAligned: true,
    },
  }, fixture).ok, true)
  assert.equal(tauriE2e.evaluateReleaseBehavior('release-session-ownership', {
    sessions: [
      { key: 'agent:sales:main', agentId: 'sales', kind: 'main' },
      { key: 'agent:sales:cron:daily-report', agentId: 'sales', kind: 'cron' },
    ],
  }, fixture).ok, true)
  assert.equal(tauriE2e.evaluateReleaseBehavior('release-plugin-catalog', {
    profile: 'release-profile',
    gatewaySupportsToolConstraints: true,
    plugins: [{
      id: 'uniopc-local-workspace',
      enabled: true,
      installed: true,
      status: 'ready',
      businessHealthState: 'ready',
      readinessReasons: [],
      tools: [{ name: 'uniopc_local_documents_list' }],
    }],
  }, fixture).ok, true)
  assert.equal(tauriE2e.evaluateReleaseBehavior('release-local-workspace-tool', {
    accepted: {
      content: '',
      run_id: 'run-local-workspace',
      model: 'gateway-session',
      gateway_session_key: 'agent:sales:main',
      gateway_aligned: true,
    },
    previousAssistantIds: ['assistant-before'],
    beforeDisplayText: 'Conversation before the workspace probe.',
    beforeHistory: {
      messages: [{ id: 'assistant-before', role: 'assistant', content: 'Earlier answer.' }],
    },
    workspaceDocument: { id: 'doc-release-proof', title: 'release-document-sentinel' },
    history: {
      session_key: 'agent:sales:main',
      has_active_run: false,
      model_provider: 'openai-codex',
      model: 'gpt-5.5',
      gateway_aligned: true,
      messages: [
        {
          id: 'user-release-probe',
          role: 'user',
          content: 'List the current local document titles.',
          idempotency_key: 'e2e-local-workspace-turn',
        },
        { id: 'assistant-release-probe', role: 'assistant', content: 'Found release-document-sentinel.' },
      ],
    },
  }, fixture).ok, true)
  assert.equal(tauriE2e.evaluateReleaseBehavior('release-truthful-error', {
    beforeErrorText: 'Conversation has no failure banner.',
    errorText: '发送失败：模型账号鉴权失败，请重新绑定。',
    ipcEvent: {
      sequence: 41,
      command: 'conversation_send_turn',
      args: {
        req: {
          profile: 'release-profile',
          sessionKey: 'agent:sales:main',
          input: 'Trigger the configured synthetic authentication failure.',
          idempotencyKey: 'e2e-failure-bound-turn',
        },
      },
      status: 'rejected',
      result: null,
      error: '401 unauthorized',
    },
  }, fixture).ok, true)
})

test('release behavior assertions reject plausible false-positive evidence', () => {
  assert.equal(typeof tauriE2e.evaluateReleaseBehavior, 'function')
  if (typeof tauriE2e.evaluateReleaseBehavior !== 'function') return

  const fixture = {
    profile: 'release-profile',
    agentId: 'sales',
    mainSessionKey: 'agent:sales:main',
    cronSessionKey: 'agent:sales:cron:daily-report',
    expectedModel: 'openai-codex/gpt-5.5',
    expectedModelLabel: '5.5',
    localWorkspacePrompt: 'List the current local document titles.',
    workspaceProofTitle: 'release-document-sentinel',
    localWorkspaceIdempotencyKey: 'e2e-local-workspace-turn',
    failureKind: 'upstream',
    failurePrompt: 'Trigger the configured synthetic upstream failure.',
    failureExpectedText: '上游服务暂时不可用',
    failureIdempotencyKey: 'e2e-failure-bound-turn',
    failureMonitorBaseline: 40,
    failureEventSequence: 41,
  }

  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-model-identity', {
    display: {
      route: '/conversations',
      selectedSessionKey: 'agent:sales:main',
      modelLabel: '5.5',
    },
    history: {
      sessionKey: 'agent:sales:main',
      modelProvider: 'openai-codex',
      model: 'gpt-5.4',
      gatewayAligned: true,
    },
  }, fixture), /actual model/i)
  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-session-ownership', {
    sessions: [
      { key: 'agent:sales:main', agentId: 'sales', kind: 'main' },
      { key: 'agent:sales:cron:daily-report', agentId: 'sales', kind: 'interactive' },
    ],
  }, fixture), /cron session/i)
  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-plugin-catalog', {
    profile: 'release-profile',
    gatewaySupportsToolConstraints: true,
    plugins: [{
      id: 'uniopc-local-workspace',
      enabled: true,
      installed: true,
      status: 'disabled',
      businessHealthState: 'ready',
      readinessReasons: [],
      tools: [{ name: 'uniopc_local_documents_list' }],
    }],
  }, fixture), /not ready/i)
  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-local-workspace-tool', {
    accepted: {
      content: '',
      run_id: 'run-local-workspace',
      model: 'gateway-session',
      gateway_session_key: 'agent:sales:main',
      gateway_aligned: true,
    },
    previousAssistantIds: ['assistant-before'],
    beforeDisplayText: 'Conversation before the workspace probe.',
    beforeHistory: {
      messages: [{ id: 'assistant-before', role: 'assistant', content: 'Earlier answer.' }],
    },
    workspaceDocument: { id: 'doc-release-proof', title: 'release-document-sentinel' },
    history: {
      session_key: 'agent:sales:main',
      has_active_run: false,
      model_provider: 'openai-codex',
      model: 'gpt-5.5',
      gateway_aligned: true,
      messages: [{
        id: 'user-release-probe',
        role: 'user',
        content: 'List the current local document titles.',
        idempotency_key: 'e2e-local-workspace-turn',
      }],
    },
  }, fixture), /new assistant result|unique workspace proof/i)
  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-truthful-error', {
    beforeErrorText: 'No failure is visible.',
    errorText: 'FetchError: openclaw upstream fetch failed undefined',
    ipcEvent: {
      sequence: 41,
      command: 'conversation_send_turn',
      args: {
        req: {
          profile: 'release-profile',
          sessionKey: 'agent:sales:main',
          input: 'Trigger the configured synthetic upstream failure.',
          idempotencyKey: 'e2e-failure-bound-turn',
        },
      },
      status: 'rejected',
      result: null,
      error: '503 upstream service unavailable',
    },
  }, fixture), /forbidden raw error/i)
})

test('model identity rejects UI evidence selected from a different session', () => {
  const fixture = {
    mainSessionKey: 'agent:sales:main',
    expectedModel: 'openai-codex/gpt-5.5',
    expectedModelLabel: '5.5',
  }

  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-model-identity', {
    display: {
      route: '/conversations',
      selectedSessionKey: 'agent:sales:cron:daily-report',
      modelLabel: '5.5',
    },
    history: {
      sessionKey: 'agent:sales:main',
      modelProvider: 'openai-codex',
      model: 'gpt-5.5',
      gatewayAligned: true,
    },
  }, fixture), /selected session/i)
})

test('local workspace evidence rejects a prompt-derived sentinel without a new bound turn', () => {
  const fixture = {
    mainSessionKey: 'agent:sales:main',
    expectedModel: 'openai-codex/gpt-5.5',
    localWorkspacePrompt: 'List documents and return prompt-visible-sentinel.',
    workspaceProofTitle: 'prompt-visible-sentinel',
    localWorkspaceIdempotencyKey: 'e2e-local-workspace-bound-turn',
  }

  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-local-workspace-tool', {
    accepted: {
      run_id: 'run-local-workspace',
      gateway_session_key: 'agent:sales:main',
      gateway_aligned: true,
    },
    previousAssistantIds: ['old-assistant'],
    beforeDisplayText: 'No release fixture is visible.',
    beforeHistory: {
      messages: [{ id: 'old-user', role: 'user', content: 'Earlier message.' }],
    },
    workspaceDocument: { id: 'doc-random', title: 'prompt-visible-sentinel' },
    history: {
      session_key: 'agent:sales:main',
      has_active_run: false,
      model_provider: 'openai-codex',
      model: 'gpt-5.5',
      gateway_aligned: true,
      messages: [
        { id: 'old-assistant', role: 'assistant', content: 'Old answer.' },
        { id: 'new-assistant', role: 'assistant', content: 'prompt-visible-sentinel' },
      ],
    },
  }, fixture), /prompt|bound user turn/i)
})

test('truthful error rejects a marker that was already present before the new failed operation', () => {
  const fixture = {
    profile: 'release-profile',
    mainSessionKey: 'agent:sales:main',
    failureKind: 'authentication',
    failurePrompt: 'Trigger the configured synthetic authentication failure.',
    failureExpectedText: '模型账号鉴权失败',
    failureIdempotencyKey: 'e2e-failure-bound-turn',
    failureMonitorBaseline: 40,
    failureEventSequence: 41,
  }
  const staleError = '发送失败：模型账号鉴权失败，请重新绑定。'

  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-truthful-error', {
    beforeErrorText: staleError,
    errorText: staleError,
    ipcEvent: {
      sequence: 41,
      command: 'conversation_send_turn',
      args: {
        req: {
          profile: 'release-profile',
          sessionKey: 'agent:sales:main',
          input: 'Trigger the configured synthetic authentication failure.',
          idempotencyKey: 'e2e-failure-bound-turn',
        },
      },
      status: 'rejected',
      result: null,
      error: staleError,
    },
  }, fixture), /already present|before the new failure/i)
})

test('truthful error rejects stale, pending, or wrong-prompt invoke evidence', () => {
  const fixture = {
    profile: 'release-profile',
    mainSessionKey: 'agent:sales:main',
    failureKind: 'authentication',
    failurePrompt: 'Trigger this exact failure.',
    failureExpectedText: '模型账号鉴权失败',
    failureIdempotencyKey: 'bound-at-invoke-start',
    failureMonitorBaseline: 40,
    failureEventSequence: 41,
  }
  const baseEvidence = {
    beforeErrorText: '',
    errorText: '发送失败：模型账号鉴权失败，请重新绑定。',
    ipcEvent: {
      sequence: 41,
      command: 'conversation_send_turn',
      args: {
        req: {
          profile: fixture.profile,
          sessionKey: fixture.mainSessionKey,
          input: fixture.failurePrompt,
          idempotencyKey: fixture.failureIdempotencyKey,
        },
      },
      status: 'rejected',
      result: null,
      error: '401 unauthorized',
    },
  }

  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-truthful-error', {
    ...baseEvidence,
    ipcEvent: { ...baseEvidence.ipcEvent, sequence: 40 },
  }, fixture), /baseline|new failure/i)
  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-truthful-error', {
    ...baseEvidence,
    ipcEvent: { ...baseEvidence.ipcEvent, status: 'pending', error: null },
  }, fixture), /reject|failed/i)
  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-truthful-error', {
    ...baseEvidence,
    ipcEvent: {
      ...baseEvidence.ipcEvent,
      args: { req: { ...baseEvidence.ipcEvent.args.req, input: 'A different failure prompt.' } },
    },
  }, fixture), /prompt|input/i)
  assert.throws(() => tauriE2e.evaluateReleaseBehavior('release-truthful-error', {
    ...baseEvidence,
    ipcEvent: { ...baseEvidence.ipcEvent, sequence: 42 },
  }, fixture), /same invoke event|sequence/i)
})

test('truthful error runner rejects a terminal failure from a second matching invoke event', async () => {
  const behavior = tauriE2e.RELEASE_BEHAVIOR_CASES.find(item => item.id === 'release-truthful-error')
  const fixture = {
    profile: 'release-profile',
    mainSessionKey: 'agent:sales:main',
    failureKind: 'authentication',
    failurePrompt: 'Trigger this exact failure.',
    failureExpectedText: '模型账号鉴权失败',
    missing: [],
  }
  const request = {
    profile: fixture.profile,
    sessionKey: fixture.mainSessionKey,
    input: fixture.failurePrompt,
    idempotencyKey: 'same-idempotency-for-both-events',
  }
  const events = [
    {
      sequence: 1,
      command: 'conversation_send_turn',
      args: { req: request },
      status: 'pending',
      result: null,
      error: null,
    },
    {
      sequence: 2,
      command: 'conversation_send_turn',
      args: { req: request },
      status: 'rejected',
      result: null,
      error: '401 unauthorized',
    },
  ]
  let submitted = false
  let clock = 0
  const client = {
    executeJs: async script => {
      if (script.includes('const textOf = () =>')) return true
      if (script.includes('window.__IMAI_E2E__.navigate')) return '/conversations'
      if (script.includes('data-e2e-active-session-key')) return true
      if (script.includes('selectConversationSession')) return true
      if (script.includes('installFailureInvokeMonitor')) return true
      if (script === 'window.__IMAI_E2E__.failureInvokeBaseline()') return 0
      if (script.includes('typeConversation')) return true
      if (script.includes('submitConversation')) {
        submitted = true
        return true
      }
      if (script.includes('failureInvokeEventsAfter')) return events
      if (script.includes('document.body.innerText.includes')) return true
      if (script.includes('releaseSnapshot(')) {
        return { errorText: submitted ? '发送失败：模型账号鉴权失败，请重新绑定。' : '' }
      }
      if (script.includes('restoreFailureInvokeMonitor')) return true
      throw new Error(`Unexpected executeJs: ${script.slice(0, 100)}`)
    },
  }

  const cases = await tauriE2e.runReleaseBehaviorAssertions({
    client,
    fixture,
    behaviorCases: [behavior],
    logger: { write: async () => {} },
    sleepFn: async () => {},
    nowFn: () => (clock += 10_000),
  })

  assert.equal(cases[0].status, 'failed')
  assert.match(cases[0].error, /same invoke event|sequence/i)
})

test('release behavior runner binds bridge calls, polling, and cleanup to fresh evidence', async () => {
  assert.equal(typeof tauriE2e.runReleaseBehaviorAssertions, 'function')

  const proofTitle = 'Uniopc E2E workspace proof workspace-proof-uuid'
  const idempotencyKey = 'e2e-local-workspace-workspace-turn-uuid'
  const fixture = {
    profile: 'release-profile',
    agentId: 'sales',
    mainSessionKey: 'agent:sales:main',
    cronSessionKey: 'agent:sales:cron:daily-report',
    expectedModel: 'openai-codex/gpt-5.5',
    expectedModelLabel: '5.5',
    localWorkspacePrompt: 'List the current local document titles.',
    failureKind: 'authentication',
    failurePrompt: 'Trigger the configured synthetic authentication failure.',
    failureExpectedText: '模型账号鉴权失败',
    missing: [],
  }
  const wrongPromptEvent = {
    sequence: 41,
    command: 'conversation_send_turn',
    args: {
      req: {
        profile: fixture.profile,
        sessionKey: fixture.mainSessionKey,
        input: 'A different failure prompt.',
        idempotencyKey: 'wrong-prompt-idempotency',
      },
    },
    status: 'rejected',
    result: null,
    error: '401 unauthorized',
  }
  const newFailureEvent = {
    sequence: 42,
    command: 'conversation_send_turn',
    args: {
      req: {
        profile: 'release-profile',
        sessionKey: 'agent:sales:main',
        input: fixture.failurePrompt,
        idempotencyKey: 'new-failure-idempotency',
      },
    },
    status: 'rejected',
    result: null,
    error: '401 unauthorized',
  }
  const historyResponses = [
    {
      sessionKey: 'agent:sales:main',
      modelProvider: 'openai-codex',
      model: 'gpt-5.5',
      gatewayAligned: true,
    },
    {
      session_key: 'agent:sales:main',
      has_active_run: false,
      model_provider: 'openai-codex',
      model: 'gpt-5.5',
      gateway_aligned: true,
      messages: [{ id: 'assistant-old', role: 'assistant', content: 'Earlier answer.' }],
    },
    {
      session_key: 'agent:sales:main',
      has_active_run: true,
      model_provider: 'openai-codex',
      model: 'gpt-5.5',
      gateway_aligned: true,
      messages: [
        { id: 'assistant-old', role: 'assistant', content: 'Earlier answer.' },
        { id: 'user-new', role: 'user', idempotency_key: idempotencyKey, content: fixture.localWorkspacePrompt },
      ],
    },
    {
      session_key: 'agent:sales:main',
      has_active_run: false,
      model_provider: 'openai-codex',
      model: 'gpt-5.5',
      gateway_aligned: true,
      messages: [
        { id: 'assistant-old', role: 'assistant', content: 'Earlier answer.' },
        { id: 'user-new', role: 'user', idempotency_key: idempotencyKey, content: fixture.localWorkspacePrompt },
        { id: 'assistant-new', role: 'assistant', content: `Found ${proofTitle}.` },
      ],
    },
  ]
  const invokes = []
  const domCalls = []
  let failureEventReads = 0
  const client = {
    executeJs: async script => {
      if (script.includes('window.__IMAI_E2E__.navigate')) {
        domCalls.push('navigate')
        return '/conversations'
      }
      if (script.includes('const textOf = () =>')) {
        domCalls.push('install')
        return true
      }
      if (script.includes('data-e2e-active-session-key')) {
        domCalls.push('wait-selected')
        return true
      }
      if (script.includes('selectConversationSession')) {
        domCalls.push('select-main')
        return true
      }
      if (script === 'window.__IMAI_E2E__.releaseSnapshot()') {
        domCalls.push('model-snapshot')
        return { route: '/conversations', selectedSessionKey: fixture.mainSessionKey, modelLabel: '5.5' }
      }
      if (script === 'window.__IMAI_E2E__.snapshot()') {
        domCalls.push('workspace-before-snapshot')
        return { route: '/conversations', text: 'Earlier answer without the generated proof.' }
      }
      if (script.includes('typeConversation')) {
        domCalls.push('type-failure')
        return true
      }
      if (script.includes('installFailureInvokeMonitor')) {
        domCalls.push('install-failure-monitor')
        return true
      }
      if (script === 'window.__IMAI_E2E__.failureInvokeBaseline()') {
        domCalls.push('failure-monitor-baseline')
        return 40
      }
      if (script.includes('failureInvokeEventsAfter')) {
        failureEventReads += 1
        domCalls.push(`failure-event-read-${failureEventReads}`)
        return failureEventReads === 1
          ? [wrongPromptEvent, { ...newFailureEvent, status: 'pending', error: null }]
          : [wrongPromptEvent, { ...newFailureEvent, sequence: 43 }, newFailureEvent]
      }
      if (script.includes('restoreFailureInvokeMonitor')) {
        domCalls.push('restore-failure-monitor')
        return true
      }
      if (script.includes('submitConversation')) {
        domCalls.push('submit-failure')
        return true
      }
      if (script.includes('document.body.innerText.includes')) {
        domCalls.push('wait-failure')
        return true
      }
      if (script.includes('releaseSnapshot(')) {
        const afterSubmit = domCalls.includes('submit-failure')
        domCalls.push(afterSubmit ? 'failure-after-snapshot' : 'failure-before-snapshot')
        return { errorText: afterSubmit ? '发送失败：模型账号鉴权失败，请重新绑定。' : '' }
      }
      throw new Error(`Unexpected executeJs: ${script.slice(0, 100)}`)
    },
    invoke: async (command, args) => {
      invokes.push({ command, args })
      if (command === 'conversation_load_history') return historyResponses.shift()
      if (command === 'conversation_list_sessions') return {
        sessions: [
          { key: fixture.mainSessionKey, agentId: 'sales', kind: 'main' },
          { key: fixture.cronSessionKey, agentId: 'sales', kind: 'cron' },
        ],
      }
      if (command === 'openclaw_profile_tool_capabilities_list') return {
        profile: fixture.profile,
        gatewaySupportsToolConstraints: true,
        plugins: [{
          id: 'uniopc-local-workspace',
          enabled: true,
          installed: true,
          status: 'ready',
          businessHealthState: 'ready',
          readinessReasons: [],
          tools: [{ name: 'uniopc_local_documents_list' }],
        }],
      }
      if (command === 'local_document_create') return { document: { id: 'doc-proof', title: proofTitle } }
      if (command === 'local_documents_list') return { documents: [{ id: 'doc-proof', title: proofTitle }] }
      if (command === 'conversation_send_turn') return {
        run_id: 'run-workspace-new',
        gateway_session_key: fixture.mainSessionKey,
        gateway_aligned: true,
      }
      if (command === 'local_document_archive') return { document: { id: 'doc-proof', archived: true } }
      throw new Error(`Unexpected invoke: ${command}`)
    },
    command: async command => { throw new Error(`Unexpected MCP bridge call: ${command}`) },
  }
  const uuids = ['workspace-proof-uuid', 'workspace-turn-uuid']

  const cases = await tauriE2e.runReleaseBehaviorAssertions({
    client,
    fixture,
    logger: { write: async () => {} },
    randomUUIDFn: () => uuids.shift(),
    sleepFn: async () => {},
  })

  assert.deepEqual(cases.map(item => [item.id, item.status]), [
    ['release-model-identity', 'passed'],
    ['release-session-ownership', 'passed'],
    ['release-plugin-catalog', 'passed'],
    ['release-local-workspace-tool', 'passed'],
    ['release-truthful-error', 'passed'],
  ])
  assert.equal(domCalls.filter(call => call === 'select-main').length, 3)
  assert.ok(domCalls.indexOf('install-failure-monitor') < domCalls.indexOf('submit-failure'))
  assert.ok(domCalls.indexOf('failure-monitor-baseline') < domCalls.indexOf('submit-failure'))
  assert.ok(domCalls.indexOf('failure-event-read-1') > domCalls.indexOf('submit-failure'))
  assert.ok(domCalls.indexOf('restore-failure-monitor') > domCalls.indexOf('failure-event-read-2'))
  assert.equal(cases.find(item => item.id === 'release-truthful-error').evidence.eventSequence, 42)
  assert.deepEqual(invokes.map(call => call.command), [
    'conversation_load_history',
    'conversation_list_sessions',
    'openclaw_profile_tool_capabilities_list',
    'conversation_load_history',
    'local_document_create',
    'local_documents_list',
    'conversation_send_turn',
    'conversation_load_history',
    'conversation_load_history',
    'local_document_archive',
  ])
  const create = invokes.find(call => call.command === 'local_document_create')
  assert.equal(create.args.input.profile, fixture.profile)
  assert.equal(create.args.input.title, proofTitle)
  const list = invokes.find(call => call.command === 'local_documents_list')
  assert.equal(list.args.input.profile, fixture.profile)
  const send = invokes.find(call => call.command === 'conversation_send_turn')
  assert.equal(send.args.req.idempotencyKey, idempotencyKey)
  assert.equal(send.args.req.input.includes(proofTitle), false)
  const archive = invokes.find(call => call.command === 'local_document_archive')
  assert.deepEqual(archive.args, { input: { profile: fixture.profile, id: 'doc-proof' } })
})

test('truthful error runner restores the invoke monitor when evidence capture fails', async () => {
  const behavior = tauriE2e.RELEASE_BEHAVIOR_CASES.find(item => item.id === 'release-truthful-error')
  const fixture = {
    profile: 'release-profile',
    mainSessionKey: 'agent:sales:main',
    failureKind: 'authentication',
    failurePrompt: 'Trigger this exact failure.',
    failureExpectedText: '模型账号鉴权失败',
    missing: [],
  }
  const calls = []
  const client = {
    executeJs: async script => {
      if (script.includes('const textOf = () =>')) return true
      if (script.includes('window.__IMAI_E2E__.navigate')) return '/conversations'
      if (script.includes('selectConversationSession')) return true
      if (script.includes('data-e2e-active-session-key')) return true
      if (script.includes('releaseSnapshot(')) return { errorText: '' }
      if (script.includes('installFailureInvokeMonitor')) {
        calls.push('install')
        return true
      }
      if (script === 'window.__IMAI_E2E__.failureInvokeBaseline()') return 0
      if (script.includes('typeConversation')) return false
      if (script.includes('restoreFailureInvokeMonitor')) {
        calls.push('restore')
        return true
      }
      throw new Error(`Unexpected executeJs: ${script.slice(0, 100)}`)
    },
  }

  const cases = await tauriE2e.runReleaseBehaviorAssertions({
    client,
    fixture,
    behaviorCases: [behavior],
    logger: { write: async () => {} },
    sleepFn: async () => {},
  })

  assert.deepEqual(calls, ['install', 'restore'])
  assert.equal(cases[0].status, 'failed')
  assert.match(cases[0].error, /could not type/i)
})

test('release behavior runner reports local workspace archive cleanup failure', async () => {
  const behavior = tauriE2e.RELEASE_BEHAVIOR_CASES.find(item => item.id === 'release-local-workspace-tool')
  const proofTitle = 'Uniopc E2E workspace proof cleanup-proof'
  const fixture = {
    profile: 'release-profile',
    agentId: 'sales',
    mainSessionKey: 'agent:sales:main',
    expectedModel: 'openai-codex/gpt-5.5',
    localWorkspacePrompt: 'List the current local document titles.',
    missing: [
      'IMAI_E2E_EXPECTED_MODEL_LABEL',
      'IMAI_E2E_CRON_SESSION_KEY',
      'IMAI_E2E_FAILURE_KIND',
    ],
  }
  const histories = [
    {
      session_key: fixture.mainSessionKey,
      has_active_run: false,
      model_provider: 'openai-codex',
      model: 'gpt-5.5',
      gateway_aligned: true,
      messages: [{ id: 'old', role: 'assistant', content: 'Old answer.' }],
    },
  ]
  const client = {
    executeJs: async script => (
      script === 'window.__IMAI_E2E__.snapshot()'
        ? { text: 'Old answer.' }
        : true
    ),
    invoke: async (command) => {
      if (command === 'openclaw_profile_tool_capabilities_list') return {}
      if (command === 'conversation_load_history') return histories.shift()
      if (command === 'local_document_create') return { document: { id: 'cleanup-doc', title: proofTitle } }
      if (command === 'local_documents_list') return { documents: [{ id: 'cleanup-doc', title: proofTitle }] }
      if (command === 'conversation_send_turn') throw new Error('send failed before completion')
      if (command === 'local_document_archive') throw new Error('archive cleanup failed')
      throw new Error(`Unexpected invoke ${command}`)
    },
  }
  const uuids = ['cleanup-proof', 'cleanup-turn']

  const cases = await tauriE2e.runReleaseBehaviorAssertions({
    client,
    fixture,
    logger: { write: async () => {} },
    behaviorCases: [behavior],
    randomUUIDFn: () => uuids.shift(),
    sleepFn: async () => {},
  })

  assert.equal(cases.length, 1)
  assert.equal(cases[0].status, 'failed')
  assert.match(cases[0].error, /archive cleanup failed/i)
})

test('required release evidence skips make the E2E summary incomplete', () => {
  const summary = buildSummary({
    startedAt: '2026-09-10T00:00:00.000Z',
    finishedAt: '2026-09-10T00:00:01.000Z',
    cases: [{
      id: 'release-model-identity',
      status: 'skipped',
      requiredEvidence: true,
      reason: 'missing fixture',
    }],
    reportDir: 'reports/e2e-tauri/run',
    appStartedByRunner: true,
  })

  assert.equal(summary.status, 'incomplete')
  assert.equal(summary.requiredEvidenceMissing, 1)
})
