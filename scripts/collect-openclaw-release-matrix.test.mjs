import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectReleaseMatrix } from './collect-openclaw-release-matrix.mjs'

const bytes = Buffer.from('real plugin archive fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')

function request() {
  return {
    schemaVersion: 1,
    runtimeVersion: '2026.8.1',
    nodeVersion: '24.19.0',
    desktopTarget: 'x86_64-pc-windows-msvc',
    commit: 'a'.repeat(40),
    runId: 'github-123',
  }
}

function response({ expectedSha256 = sha256, downloadUrl = 'https://storage.example/signed-a' } = {}) {
  return {
    schemaVersion: 1,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    artifacts: [{
      id: 'plugin-a@1.0.0',
      pluginId: 'plugin-a',
      version: '1.0.0',
      artifactPath: 'plugin-a/1.0.0/plugin-a.zip',
      sha256: expectedSha256,
      pluginApi: '>=2026.8.1 <2027.0.0',
      readOnlyTool: { name: 'a_status', arguments: {} },
      downloadUrl,
    }],
  }
}

test('writes exact artifacts without URL or token', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'uniopc-collector-'))
  const fetch = async (url, init) => {
    if (String(url).endsWith('/prepare-openclaw-release')) {
      assert.equal(init.headers['x-release-token'], 'prepare-secret')
      return Response.json(response())
    }
    assert.equal(String(url), 'https://storage.example/signed-a')
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
  }

  const result = await collectReleaseMatrix({
    endpoint: 'https://server.example/functions/v1/prepare-openclaw-release',
    token: 'prepare-secret',
    request: request(),
    outputDirectory,
    fetch,
    maxArtifactBytes: 1024,
  })
  const serialized = await readFile(result.matrixPath, 'utf8')
  assert.doesNotMatch(serialized, /prepare-secret|signed-a|storage\.example/)
  const matrix = JSON.parse(serialized)
  assert.deepEqual(Object.keys(matrix).sort(), ['artifacts', 'attestation', 'schemaVersion'])
  assert.equal(matrix.attestation, 'release.attestation.json')
  assert.deepEqual(Object.keys(matrix.artifacts[0]).sort(), [
    'artifact', 'id', 'pluginApi', 'pluginId', 'readOnlyTool', 'sha256',
  ])
  assert.equal(matrix.artifacts[0].artifact, `artifacts/${sha256}.zip`)
})

test('removes staging on SHA mismatch or untrusted redirect', async () => {
  const mismatch = await collectorFixture({ expectedSha256: 'f'.repeat(64) })
  const redirect = await collectorFixture({ downloadUrl: 'https://attacker.example/a.zip' })
  await assert.rejects(() => collectReleaseMatrix(mismatch), /artifact_sha_mismatch/)
  await assert.rejects(() => collectReleaseMatrix(redirect), /artifact_origin_invalid/)
})

async function collectorFixture({ expectedSha256 = sha256, downloadUrl = 'https://storage.example/a.zip' } = {}) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'uniopc-collector-negative-'))
  return {
    endpoint: 'https://server.example/functions/v1/prepare-openclaw-release',
    token: 'prepare-secret',
    outputDirectory,
    maxArtifactBytes: 1024,
    request: request(),
    fetch: async (url) => String(url).includes('prepare-openclaw-release')
      ? Response.json(response({ expectedSha256, downloadUrl }))
      : new Response(bytes),
  }
}
