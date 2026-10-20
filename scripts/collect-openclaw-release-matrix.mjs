import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEX_64 = /^[0-9a-f]{64}$/

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function validatePrepareResponse(value) {
  if (!exactKeys(value, ['schemaVersion', 'expiresAt', 'artifacts']) || value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
    throw new Error('matrix_response_invalid')
  }
  if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw new Error('matrix_response_invalid')
  }
  const ids = new Set()
  for (const item of value.artifacts) {
    if (!exactKeys(item, ['id', 'pluginId', 'version', 'artifactPath', 'sha256', 'pluginApi', 'readOnlyTool', 'downloadUrl'])) {
      throw new Error('matrix_response_invalid')
    }
    if (!item.id || ids.has(item.id) || !HEX_64.test(item.sha256) || !item.downloadUrl || !item.artifactPath) {
      throw new Error('matrix_response_invalid')
    }
    ids.add(item.id)
  }
  if (value.artifacts.length === 0) throw new Error('matrix_response_invalid')
  return value
}

function trustedStorageOrigin(url, endpointUrl) {
  if (url.origin === endpointUrl.origin) return true
  const suffix = endpointUrl.hostname.split('.').slice(1).join('.')
  return Boolean(suffix) && url.hostname.startsWith('storage.') && url.hostname.endsWith(`.${suffix}`)
}

async function createOwnedStagingDirectory(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true })
  const staging = await mkdtemp(join(outputDirectory, '.release-matrix-'))
  await mkdir(join(staging, 'artifacts'))
  return staging
}

async function streamResponseToHashedFile(response, destination, { expectedSha256, maxBytes }) {
  if (!response.ok || !response.body) throw new Error('artifact_download_failed')
  const advertisedLength = Number(response.headers.get('content-length') || 0)
  if (!Number.isSafeInteger(advertisedLength) || advertisedLength < 0 || advertisedLength > maxBytes) {
    throw new Error('artifact_size_invalid')
  }
  const temporary = `${destination}.partial`
  const hash = createHash('sha256')
  let bytes = 0
  const handle = await open(temporary, 'wx')
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxBytes) throw new Error('artifact_size_invalid')
      hash.update(buffer)
      await handle.write(buffer)
    }
    if (advertisedLength && bytes !== advertisedLength) throw new Error('artifact_size_invalid')
    if (hash.digest('hex') !== expectedSha256) throw new Error('artifact_sha_mismatch')
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temporary, { force: true })
    throw error
  }
  await handle.close()
  await rename(temporary, destination)
}

function releaseMatrixFromResponse(payload) {
  return {
    schemaVersion: 1,
    attestation: 'release.attestation.json',
    artifacts: payload.artifacts.map((item) => ({
      id: item.id,
      pluginId: item.pluginId,
      artifact: `artifacts/${item.sha256}.zip`,
      sha256: item.sha256,
      pluginApi: item.pluginApi,
      readOnlyTool: item.readOnlyTool,
    })),
  }
}

async function writeCanonicalMatrix(staging, matrix) {
  const matrixPath = join(staging, 'release.matrix.json')
  await writeFile(matrixPath, `${canonicalJson(matrix)}\n`, { flag: 'wx' })
  return matrixPath
}

export async function collectReleaseMatrix({
  endpoint,
  token,
  request,
  outputDirectory,
  fetch = globalThis.fetch,
  maxArtifactBytes = 256 * 1024 * 1024,
}) {
  const endpointUrl = new URL(endpoint)
  if (endpointUrl.protocol !== 'https:' || !token || !Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= 0) {
    throw new Error('endpoint_invalid')
  }
  const response = await fetch(endpointUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-release-token': token },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`matrix_request_failed_${response.status}`)
  const payload = validatePrepareResponse(await response.json())
  const staging = await createOwnedStagingDirectory(outputDirectory)
  try {
    for (const item of payload.artifacts) {
      const url = new URL(item.downloadUrl)
      if (url.protocol !== 'https:' || !trustedStorageOrigin(url, endpointUrl)) throw new Error('artifact_origin_invalid')
      const artifactResponse = await fetch(url, { redirect: 'error' })
      await streamResponseToHashedFile(artifactResponse, join(staging, 'artifacts', `${item.sha256}.zip`), {
        expectedSha256: item.sha256,
        maxBytes: maxArtifactBytes,
      })
    }
    const matrix = releaseMatrixFromResponse(payload)
    const matrixPath = await writeCanonicalMatrix(staging, matrix)
    return {
      matrixPath,
      artifactsDirectory: join(staging, 'artifacts'),
      responseSha256: sha256Canonical(payload),
      artifactCount: matrix.artifacts.length,
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

async function main() {
  const endpoint = process.env.UNIOPC_RELEASE_PREPARE_URL || ''
  const token = process.env.UNIOPC_RELEASE_PREPARE_TOKEN || ''
  const outputDirectory = process.env.UNIOPC_RELEASE_MATRIX_OUTPUT_DIR || join(process.cwd(), '.release-matrix')
  const request = {
    schemaVersion: 1,
    runtimeVersion: '2026.8.1',
    nodeVersion: '24.19.0',
    desktopTarget: process.env.UNIOPC_RELEASE_DESKTOP_TARGET || '',
    commit: process.env.GITHUB_SHA || '',
    runId: process.env.GITHUB_RUN_ID || '',
  }
  const result = await collectReleaseMatrix({ endpoint, token, request, outputDirectory })
  process.stdout.write(`${JSON.stringify({ matrixPath: result.matrixPath, artifactCount: result.artifactCount })}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'release_matrix_collection_failed'}\n`)
    process.exitCode = 1
  })
}
