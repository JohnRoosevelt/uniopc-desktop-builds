import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { configureReleaseCi } from './configure-openclaw-release-ci.mjs'

const values = {
  UNIOPC_RELEASE_PREPARE_URL: 'https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/prepare-openclaw-release',
  UNIOPC_RELEASE_PREPARE_TOKEN: 'prepare-secret',
  UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY: 'private-key',
  UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY: 'public-key',
  UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID: 'openclaw-audit-aabbccddeeff0011',
}

test('passes GitHub secret values only over stdin and returns only updated names', async () => {
  const calls = []
  const result = await configureReleaseCi({
    values,
    run: async (command, args, options) => calls.push({ command, args, stdin: options.stdin }),
  })

  assert.equal(calls.every(({ command }) => command === 'gh'), true)
  assert.equal(calls.every(({ args }) => !args.join(' ').includes('prepare-secret') && !args.join(' ').includes('private-key')), true)
  assert.equal(calls.filter(({ args }) => args[0] === 'secret').length, 4)
  assert.deepEqual(calls.filter(({ args }) => args[0] === 'secret').map(({ args }) => args), [
    ['secret', 'set', 'UNIOPC_RELEASE_PREPARE_URL'],
    ['secret', 'set', 'UNIOPC_RELEASE_PREPARE_TOKEN'],
    ['secret', 'set', 'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY'],
    ['secret', 'set', 'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY'],
  ])
  assert.deepEqual(calls.find(({ args }) => args[0] === 'variable').args, [
    'variable', 'set', 'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID', '--body', 'openclaw-audit-aabbccddeeff0011',
  ])
  assert.deepEqual(result, {
    updated: [
      'UNIOPC_RELEASE_PREPARE_URL',
      'UNIOPC_RELEASE_PREPARE_TOKEN',
      'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY',
      'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY',
      'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID',
    ],
  })
  assert.doesNotMatch(JSON.stringify(result), /prepare-secret|private-key|public-key/)
})

test('rejects unknown or missing CI values before invoking gh', async () => {
  let called = false
  await assert.rejects(() => configureReleaseCi({
    values: { ...values, UNEXPECTED: 'value' },
    run: async () => { called = true },
  }), /release_ci_values_invalid/)
  assert.equal(called, false)
  await assert.rejects(() => configureReleaseCi({
    values: { ...values, UNIOPC_RELEASE_PREPARE_TOKEN: '' },
    run: async () => { called = true },
  }), /release_ci_values_invalid/)
  assert.equal(called, false)
  await assert.rejects(() => configureReleaseCi({
    values: { ...values, UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID: 'openclaw-audit-aabbccddeeff0011&unsafe' },
    run: async () => { called = true },
  }), /release_ci_values_invalid/)
  assert.equal(called, false)
})

test('rejects an unapproved release endpoint before invoking gh', async () => {
  let called = false
  await assert.rejects(() => configureReleaseCi({
    values: { ...values, UNIOPC_RELEASE_PREPARE_URL: 'https://server.example/functions/v1/prepare-openclaw-release' },
    run: async () => { called = true },
  }), /release_ci_values_invalid/)
  await assert.rejects(() => configureReleaseCi({
    values: { ...values, UNIOPC_RELEASE_PREPARE_URL: 'https://spb-bp10i1915oj07495.supabase.opentrust.net/functions/v1/prepare-openclaw-release' },
    run: async () => { called = true },
  }), /release_ci_values_invalid/)
  assert.equal(called, false)
})

test('CLI accepts Task 5 secrets-env and prepare-url arguments without network access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-configure-ci-'))
  const secretsFile = join(root, 'secrets.env')
  const ghLog = join(root, 'gh.log')
  const ghDir = join(root, 'bin')
  const scriptPath = fileURLToPath(new URL('./configure-openclaw-release-ci.mjs', import.meta.url))
  await (await import('node:fs/promises')).mkdir(ghDir)
  const ghPath = process.platform === 'win32' ? join(ghDir, 'gh.cmd') : join(ghDir, 'gh')
  const fakeGh = process.platform === 'win32'
    ? `@echo %*>>"${ghLog}"\r\n@exit /b 0\r\n`
    : `#!/bin/sh\nprintf '%s\\n' \"$*\" >> '${ghLog}'\n`
  await writeFile(ghPath, fakeGh, { mode: 0o700 })
  await writeFile(secretsFile, [
    'UNIOPC_RELEASE_PREPARE_URL=',
    'UNIOPC_RELEASE_PREPARE_TOKEN=prepare-secret',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY=private-key',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY=public-key',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID=openclaw-audit-aabbccddeeff0011',
    'UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE=release-nonce',
    '',
  ].join('\n'))
  const result = spawnSync(process.execPath, [scriptPath,
    '--secrets-env', secretsFile,
    '--prepare-url', 'https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/prepare-openclaw-release',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${ghDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"updated"/)
  const calls = await (await import('node:fs/promises')).readFile(ghLog, 'utf8')
  assert.match(calls, /secret set UNIOPC_RELEASE_PREPARE_URL/)
  assert.match(calls, /variable set UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID/)
})

test('CLI preserves the approved nonblank URL compatibility path for secrets-file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-configure-ci-file-'))
  const secretsFile = join(root, 'secrets.env')
  const ghLog = join(root, 'gh.log')
  const ghDir = join(root, 'bin')
  const scriptPath = fileURLToPath(new URL('./configure-openclaw-release-ci.mjs', import.meta.url))
  await (await import('node:fs/promises')).mkdir(ghDir)
  const ghPath = process.platform === 'win32' ? join(ghDir, 'gh.cmd') : join(ghDir, 'gh')
  await writeFile(ghPath, process.platform === 'win32'
    ? `@echo %*>>"${ghLog}"\r\n@exit /b 0\r\n`
    : `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\n`, { mode: 0o700 })
  await writeFile(secretsFile, [
    'UNIOPC_RELEASE_PREPARE_URL=https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/prepare-openclaw-release',
    'UNIOPC_RELEASE_PREPARE_TOKEN=prepare-secret',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY=private-key',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY=public-key',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID=openclaw-audit-aabbccddeeff0011',
    '',
  ].join('\n'))
  const result = spawnSync(process.execPath, [scriptPath, '--secrets-file', secretsFile], {
    encoding: 'utf8', env: { ...process.env, PATH: `${ghDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(await (await import('node:fs/promises')).readFile(ghLog, 'utf8'), /secret set UNIOPC_RELEASE_PREPARE_URL/)
})

test('CLI rejects a nonblank Task 5 source URL and malformed replacement endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-configure-ci-invalid-'))
  const secretsFile = join(root, 'secrets.env')
  const scriptPath = fileURLToPath(new URL('./configure-openclaw-release-ci.mjs', import.meta.url))
  await writeFile(secretsFile, [
    'UNIOPC_RELEASE_PREPARE_URL=https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/prepare-openclaw-release',
    'UNIOPC_RELEASE_PREPARE_TOKEN=prepare-secret',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY=private-key',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY=public-key',
    'UNIOPC_PLUGIN_AUDIT_ATTESTATION_KEY_ID=openclaw-audit-aabbccddeeff0011',
    'UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE=release-nonce',
    '',
  ].join('\n'))
  for (const prepareUrl of [
    'http://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/prepare-openclaw-release',
    'https://token@spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/prepare-openclaw-release',
    'https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/not-prepare-openclaw-release',
    'https://other.supabase.opentrust.net/functions/v1/prepare-openclaw-release',
  ]) {
    const result = spawnSync(process.execPath, [scriptPath, '--secrets-env', secretsFile, '--prepare-url', prepareUrl], { encoding: 'utf8' })
    assert.notEqual(result.status, 0, prepareUrl)
    assert.match(result.stderr, /release_ci_values_invalid/)
  }
})
