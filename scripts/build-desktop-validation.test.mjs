import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { buildDesktopValidation, parseValidationArgs, validationEnvironment } from './build-desktop-validation.mjs'

test('validation CLI does not accept a promotion option', () => {
  assert.throws(() => parseValidationArgs(['--target', 'aarch64-apple-darwin', '--promote']), /publication is not supported/)
})

test('validation removes release credentials and uses only ad-hoc macOS identity', () => {
  const env = validationEnvironment({
    PATH: '/bin', APPLE_ID: 'fixture', APPLE_SIGNING_IDENTITY: 'Developer ID',
    TAURI_SIGNING_PRIVATE_KEY: 'fixture', IMAI_RELEASE_PUBLISH_TOKEN: 'fixture',
    SUPABASE_STORAGE_API_KEY: 'fixture',
  }, 'darwin')
  assert.deepEqual(env, { PATH: '/bin', APPLE_CODESIGN_IDENTITY: '-' })
})

for (const target of ['aarch64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']) {
  test('validation packages ' + target + ' without signing secrets or updater artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uniopc-validation-test-'))
    const config = join(root, 'runtime.json')
    await writeFile(config, JSON.stringify({ bundle: { resources: { '/fixture/runtime': 'openclaw-runtime' } } }))
    const calls = []
    let cleaned = false
    try {
      const record = await buildDesktopValidation({ target }, {
        env: {}, readVersion: async () => '0.4.12', verifyRuntime: async () => {},
        readRuntime: async () => ({ manifest: { version: '2026.8.1' } }),
        snapshotRuntime: async () => ({
          root, tauriConfigPath: config, verify: async () => true,
          cleanup: async () => { cleaned = true },
        }),
        clearRuntime: async () => {}, writeRecord: async () => {},
        run: async (args, env) => {
          calls.push(args)
          if (args.includes('tauri')) {
            const overlay = JSON.parse(await readFile(args[args.indexOf('--config') + 1], 'utf8'))
            assert.equal(overlay.bundle.createUpdaterArtifacts, false)
            assert.equal(overlay.productName, 'Uniopc Validation')
            assert.deepEqual(overlay.bundle.resources, { '/fixture/runtime': 'openclaw-runtime' })
            assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, undefined)
          }
        },
      })
      assert.equal(calls.length, 2)
      assert.equal(record.published, false)
      assert.equal(record.releaseSigningVerified, false)
      assert.equal(cleaned, true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('a runtime hash/contract failure prevents Tauri packaging even in validation mode', async () => {
  const calls = []
  await assert.rejects(buildDesktopValidation({ target: 'x86_64-unknown-linux-gnu' }, {
    env: {}, readVersion: async () => '0.4.12', run: async args => { calls.push(args) },
    verifyRuntime: async () => { throw new Error('SHA-256 mismatch') },
  }), /SHA-256 mismatch/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].includes('tauri'), false)
})
