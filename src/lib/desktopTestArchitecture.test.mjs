import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as architectureModule from './desktopTestArchitecture.js'

const {
  collectDesktopTestArchitecture,
  endToEndDimensionIds,
  extractFrontendInvokeCommands,
  mainSmokeCaseIds,
  officialParitySurfaces,
} = architectureModule
import { ENGINE_COMMANDS } from './engine/contracts.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')

test('invoke inventory resolves aliases, timeout wrappers, and local command constants', () => {
  const source = `
    import { invoke as desktopInvoke } from '@tauri-apps/api/core'
    import { invokeWithTimeout as boundedInvoke } from './tauriInvokeTimeout.js'
    const STATUS_COMMAND = 'openclaw_status'
    const COMMANDS = { pluginSet: 'openclaw_profile_plugin_set' }
    desktopInvoke(STATUS_COMMAND)
    boundedInvoke(COMMANDS.pluginSet)
  `

  assert.deepEqual(extractFrontendInvokeCommands(source), [
    'openclaw_profile_plugin_set',
    'openclaw_status',
  ])
})

test('invoke inventory resolves command-registry members only when they are wired to calls', () => {
  const source = `
    import { ENGINE_COMMANDS as commands } from './engine/contracts.js'
    commandMethod(call, commands.status.get)
    call(commands.plugins.listProfile, {})
  `

  assert.deepEqual(extractFrontendInvokeCommands(source), [
    'openclaw_profile_plugins_list',
    'openclaw_status',
  ])
})

test('frontend invoke calls are registered Tauri commands', () => {
  const architecture = collectDesktopTestArchitecture()
  const expectedEngineClientCommands = Object.values(ENGINE_COMMANDS)
    .flatMap(commands => Object.values(commands))
    .sort()

  assert.ok(architecture.registeredCommands.length >= 80)
  assert.ok(architecture.frontendInvokeCommands.length >= 62)
  assert.deepEqual(architecture.engineClientCommands, expectedEngineClientCommands)
  assert.deepEqual(architecture.unregisteredFrontendInvokes, [])
})

test('smoke manifest covers the main desktop app surfaces', () => {
  const architecture = collectDesktopTestArchitecture()

  for (const id of mainSmokeCaseIds) {
    assert.ok(
      architecture.smokeCaseIds.includes(id),
      `missing smoke case: ${id}`,
    )
  }
})

test('smoke manifest declares the complete end-to-end dimension registry', () => {
  const architecture = collectDesktopTestArchitecture()

  assert.deepEqual(architecture.e2eDimensionIds, [...endToEndDimensionIds].sort())
})

test('desktop testing docs describe every local test layer and command', () => {
  const docs = fs.readFileSync(
    path.join(repoRoot, 'docs/testing/desktop-testing.md'),
    'utf8',
  )

  for (const phrase of [
    'Rust command and service tests',
    'Frontend unit and source-contract tests',
    'Uniopc 引擎 protocol and policy contract tests',
    'Tauri smoke runner',
    'Unified runner and CI gates',
    'npm run test:desktop:js',
    'npm run test:desktop:rust',
    'npm run test:desktop:smoke:unit',
    'npm run test:desktop:all',
    'Business smoke cases',
    'openclaw-gateway-readiness',
    'conversation-stream',
    'plugin-mcp-tool-sync',
    '.github/workflows/desktop-tests.yml',
  ]) {
    assert.match(docs, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  for (const dimensionId of endToEndDimensionIds) {
    assert.match(docs, new RegExp(dimensionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('official Uniopc 引擎 macOS client parity surfaces have local guardrails', () => {
  const architecture = collectDesktopTestArchitecture()

  for (const surface of officialParitySurfaces) {
    for (const command of surface.commands) {
      assert.ok(
        architecture.registeredCommands.includes(command),
        `${surface.id} missing registered command ${command}`,
      )
    }
    for (const smokeCase of surface.smokeCases) {
      assert.ok(
        architecture.smokeCaseIds.includes(smokeCase),
        `${surface.id} missing smoke case ${smokeCase}`,
      )
    }
    for (const testFile of surface.testFiles) {
      assert.ok(
        architecture.testFiles.some(file => file.endsWith(testFile)),
        `${surface.id} missing test file ${testFile}`,
      )
    }
  }
})

test('OpenClaw 2 release behavior assertions are executable through registered commands', () => {
  assert.deepEqual(architectureModule.releaseBehaviorAssertionIds, [
    'release-model-identity',
    'release-session-ownership',
    'release-plugin-catalog',
    'release-local-workspace-tool',
    'release-truthful-error',
  ])

  const architecture = collectDesktopTestArchitecture()
  assert.deepEqual(
    architecture.releaseBehaviorAssertionIds,
    [...architectureModule.releaseBehaviorAssertionIds].sort(),
  )
  assert.deepEqual(
    architectureModule.releaseBehaviorSurfaces.find(surface => surface.id === 'release-local-workspace-tool')?.commands,
    [
      'local_document_create',
      'local_documents_list',
      'conversation_send_turn',
      'conversation_load_history',
      'local_document_archive',
    ],
  )
  for (const surface of architectureModule.releaseBehaviorSurfaces || []) {
    assert.ok(surface.commands.length >= 1, `${surface.id} must invoke production code`)
    for (const command of surface.commands) {
      assert.ok(
        architecture.registeredCommands.includes(command),
        `${surface.id} missing registered command ${command}`,
      )
    }
    for (const smokeCase of surface.smokeCases) {
      assert.ok(
        architecture.smokeCaseIds.includes(smokeCase),
        `${surface.id} missing smoke case ${smokeCase}`,
      )
    }
  }
  assert.ok(
    architecture.testFiles.some(file => file.endsWith('scripts/e2e-tauri.test.mjs')),
    'release behaviors need executable harness tests',
  )
})
