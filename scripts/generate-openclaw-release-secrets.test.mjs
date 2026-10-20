import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { generateReleaseSecrets } from './generate-openclaw-release-secrets.mjs'

const execFileAsync = promisify(execFile)

function parseEnvironment(text) {
  return Object.fromEntries(text.trim().split(/\r?\n/).map(line => {
    const index = line.indexOf('=')
    return [line.slice(0, index), line.slice(index + 1)]
  }))
}

test('generates independent canonical release secrets in a new owner-only file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-secrets-'))
  const outputPath = join(root, '.env.release-secrets')

  const report = await generateReleaseSecrets(outputPath)
  const values = parseEnvironment(await readFile(outputPath, 'utf8'))

  assert.equal(report.mode, 0o600)
  assert.match(report.keyId, /^openclaw-audit-[0-9a-f]{16}$/)
  assert.equal(report.valuesPrinted, false)
  assert.equal(report.privateKeyEqualsUpdaterKey, false)
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('icacls', [outputPath])
    assert.match(stdout, new RegExp(`${process.env.USERNAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\(F\\)`))
    assert.equal((stdout.match(/:/g) || []).length, 2)
  } else {
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600)
  }
  assert.doesNotThrow(() => createPrivateKey({ key: Buffer.from(values.UNIOPC_PLUGIN_AUDIT_ATTESTATION_PRIVATE_KEY, 'base64'), format: 'der', type: 'pkcs8' }))
  assert.doesNotThrow(() => createPublicKey({ key: Buffer.from(values.UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' }))
  assert.equal(Buffer.from(values.UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE, 'base64').length, 32)
  assert.equal(Buffer.from(values.UNIOPC_RELEASE_PREPARE_TOKEN, 'base64').length, 32)
  assert.notEqual(values.UNIOPC_PLUGIN_AUDIT_RELEASE_NONCE, values.UNIOPC_RELEASE_PREPARE_TOKEN)
  assert.equal(
    report.keyId,
    `openclaw-audit-${createHash('sha256').update(Buffer.from(values.UNIOPC_PLUGIN_AUDIT_ATTESTATION_PUBLIC_KEY, 'base64')).digest('hex').slice(0, 16)}`,
  )
})

test('refuses to overwrite a generated release secret file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-release-secrets-existing-'))
  const outputPath = join(root, '.env.release-secrets')
  await generateReleaseSecrets(outputPath)
  const original = await readFile(outputPath, 'utf8')

  await assert.rejects(() => generateReleaseSecrets(outputPath), /EEXIST/)
  assert.equal(await readFile(outputPath, 'utf8'), original)
})

test('restricts generated secrets before writing secret content', async () => {
  const events = []
  const handle = {
    async writeFile() { events.push('write') },
    async sync() { events.push('sync') },
    async close() { events.push('close') },
  }

  await generateReleaseSecrets('not-created', {}, {
    openFile: async () => { events.push('open'); return handle },
    restrictFile: async () => { events.push('restrict'); return 0o600 },
  })
  assert.deepEqual(events, ['open', 'restrict', 'write', 'sync', 'close'])
})

test('does not write generated secrets if secure ACL setup fails', async () => {
  const events = []
  const handle = {
    async writeFile() { events.push('write') },
    async close() { events.push('close') },
  }

  await assert.rejects(() => generateReleaseSecrets('not-created', {}, {
    openFile: async () => { events.push('open'); return handle },
    restrictFile: async () => { events.push('restrict'); throw new Error('acl_failed') },
  }), /acl_failed/)
  assert.deepEqual(events, ['open', 'restrict', 'close'])
})
