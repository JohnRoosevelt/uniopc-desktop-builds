import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(readFileSync(new URL('../uniopc.plugin.json', import.meta.url), 'utf8'))

const toolNames = [
  'uniopc_local_documents_list',
  'uniopc_local_document_get',
  'uniopc_local_document_create',
  'uniopc_local_document_update',
]

test('package pins the locked host contract and loads built JavaScript', () => {
  assert.deepEqual(packageJson.openclaw.extensions, ['./dist/index.js'])
  assert.equal(packageJson.peerDependencies, undefined)
  assert.equal(packageJson.openclaw.compat.pluginApi, '>=2026.8.1')
  assert.equal(packageJson.openclaw.install.minHostVersion, '>=2026.8.1')
  assert.equal(packageJson.openclaw.build.openclawVersion, '2026.8.1')
  assert.equal(packageJson.openclaw.build.pluginSdkVersion, '2026.8.1')
  assert.equal(packageJson.dependencies, undefined)
})

test('manifest preserves the four stable tool names and strict plugin config', () => {
  assert.deepEqual(manifest.contracts.tools, toolNames)
  assert.equal(manifest.configSchema.type, 'object')
  assert.equal(manifest.configSchema.additionalProperties, false)
  assert.doesNotMatch(JSON.stringify(manifest.configSchema), /TOKEN|PASSWORD|SECRET/i)
})

test('manifest uses only official replay and side-effect metadata', () => {
  const metadata = manifest.toolMetadata
  for (const name of toolNames.slice(0, 2)) {
    assert.deepEqual(metadata[name], {
      replaySafe: true,
      sideEffecting: false,
    })
  }
  for (const name of toolNames.slice(2)) {
    assert.deepEqual(metadata[name], {
      replaySafe: false,
      sideEffecting: true,
    })
  }
})

test('build output contains only the migrated runtime modules', () => {
  assert.equal(existsSync(new URL('../dist/index.js', import.meta.url)), true)
  assert.equal(existsSync(new URL('../dist/local-document-api.js', import.meta.url)), true)
  assert.equal(existsSync(new URL('../dist/register-tools.js', import.meta.url)), false)
})

test('built plugin is self-contained and never asks the host installer to create a peer link', () => {
  const output = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8')

  assert.doesNotMatch(output, /from ['"]openclaw(?:\/|['"])/)
  assert.doesNotMatch(output, /from ['"]typebox['"]/)
})
