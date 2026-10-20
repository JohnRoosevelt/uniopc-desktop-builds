#!/usr/bin/env node
// LAN-6: candidate objects are write-once; only the promotion command moves stable.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { readFile, writeFile, stat, lstat, readdir, mkdtemp, rm, copyFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolveDesktopReleaseSettings } from './desktop-release-settings.mjs'
import { readDeclaredVersion } from './verify-openclaw-release-contract.mjs'
import { readDesktopReleaseVersion } from './prepare-desktop-updater-release.mjs'
import { readDesktopUpdaterConfs, resolveUpdaterPubkeys } from './check-updater-signing-keys.mjs'
import { pickPlatformArtifacts, installerAliasFileName } from './ci-publish-desktop-artifacts.mjs'
import { buildPublicStorageUrl, compareReleaseVersions, publishReleaseRow, loadEnvFile } from './release-desktop-updater.mjs'

const PRODUCT = 'imai-desktop'
const VERSION = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)'
const stableVersion = new RegExp(`^${VERSION}$`)
const LOCK = `${PRODUCT}/stable/promotion-lock.json`
export const TARGETS = { macos: ['darwin-aarch64', 'darwin-x86_64'], windows: ['windows-x86_64'], linux: ['linux-x86_64'] }
const ROOT = resolve(import.meta.dirname, '..')
const json = value => `${JSON.stringify(value, null, 2)}\n`
const digest = value => createHash('sha256').update(value).digest('hex')
function requireCondition(value, message) { if (!value) throw new Error(message) }
function safeName(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) && !value.includes('..') }
export function planRelease(tag, expectedVersion) {
  const source = String(tag)
  const normalized = source.startsWith('test/') ? source.replace(/^test\//, '').replace(/-[1-9][0-9]*$/, '') : source
  requireCondition(!source.startsWith('test/') || /-[1-9][0-9]*$/.test(source), 'Test tag requires a positive build number')
  const match = normalized.match(new RegExp(`^(?:(desktop|macos|windows|linux)/)?v(${VERSION})$`))
  requireCondition(match, 'Use a stable tag vX.Y.Z or desktop/macos/windows/linux/vX.Y.Z')
  const platforms = match[1] || 'all'
  const version = match[2]
  requireCondition(!expectedVersion || expectedVersion === version, 'Tag version does not match desktop release version')
  const targets = platforms === 'all'
    ? [...TARGETS.macos, ...TARGETS.windows]
    : platforms === 'desktop'
      ? [...TARGETS.macos, ...TARGETS.windows]
      : TARGETS[platforms]
  return { tag, version, platforms, targets }
}
export function candidateId({ tag, commit, runId, runAttempt }) {
  const { version, platforms } = planRelease(tag)
  requireCondition(/^[0-9a-f]{40}$/.test(commit), 'Candidate requires a full commit SHA')
  requireCondition(/^[1-9][0-9]*$/.test(String(runId)) && /^[1-9][0-9]*$/.test(String(runAttempt)), 'Candidate requires workflow run and attempt')
  return `${platforms}-v${version}-${commit.slice(0, 12)}-${runId}-${runAttempt}`
}
function prefix(id) {
  requireCondition(safeName(id), 'Invalid candidate ID')
  return `${PRODUCT}/candidates/${id}`
}
function trustedKeys(repoRoot = ROOT) {
  return Object.fromEntries(Object.entries(resolveUpdaterPubkeys(readDesktopUpdaterConfs(repoRoot))).map(([target, entry]) => [target, entry.pubkey]))
}
function decodeBase64(value) {
  requireCondition(typeof value === 'string' && value.length > 0 && value.length < 16384 && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'Invalid base64 signature/key')
  const bytes = Buffer.from(value, 'base64')
  requireCondition(bytes.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, ''), 'Invalid base64 signature/key')
  return bytes
}
// Minisign format: https://jedisct1.github.io/minisign/#signature-format
// Tauri wraps the entire text signature/public key document in base64.
export async function verifyArtifactSignature(filePath, signature, publicKey) {
  const keyLines = decodeBase64(publicKey.trim()).toString('utf8').trim().split(/\r?\n/)
  requireCondition(keyLines.length === 2 && keyLines[0].startsWith('untrusted comment:'), 'Invalid public key document')
  const key = decodeBase64(keyLines[1])
  requireCondition(key.length === 42 && key.subarray(0, 2).toString() === 'Ed', 'Invalid Ed25519 public key')
  const lines = decodeBase64(signature.trim()).toString('utf8').trim().split(/\r?\n/)
  requireCondition(lines.length === 4 && lines[0].startsWith('untrusted comment:') && lines[2].startsWith('trusted comment: '), 'Invalid signature document')
  const body = decodeBase64(lines[1])
  const globalSignature = decodeBase64(lines[3])
  requireCondition(body.length === 74 && globalSignature.length === 64 && body.subarray(0, 2).toString() === 'ED', 'Require prehashed Minisign signature')
  requireCondition(body.subarray(2, 10).equals(key.subarray(2, 10)), 'Signature key ID does not match trusted platform key')
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' })
  const hash = createHash('blake2b512')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  requireCondition(verify(null, hash.digest(), pub, body.subarray(10)), 'Artifact signature verification failed')
  requireCondition(verify(null, Buffer.concat([body.subarray(10), Buffer.from(lines[2].slice('trusted comment: '.length))]), pub, globalSignature), 'Trusted signature comment verification failed')
}
async function fileInfo(filePath) {
  const info = await lstat(filePath)
  requireCondition(info.isFile() && !info.isSymbolicLink() && info.size > 0, 'Candidate artifact must be a nonempty regular file')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return { sha256: hash.digest('hex'), sizeBytes: info.size }
}
export async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    requireCondition(!entry.isSymbolicLink(), 'Symlinks are not accepted in candidate artifacts')
    if (entry.isDirectory()) files.push(...await filesIn(join(directory, entry.name)))
    else if (entry.isFile()) files.push(join(directory, entry.name))
  }
  return files
}
function targetParts(name) { const index = name.lastIndexOf('-'); return { target: name.slice(0, index), arch: name.slice(index + 1) } }
function fileKey(id, name, fileName) { requireCondition(safeName(fileName), 'Unsafe artifact file name'); return `${prefix(id)}/${name}/${fileName}` }
function manifestKey(entry) { return `${PRODUCT}/stable/${entry.target}/${entry.arch}/latest.json` }
function aliasKey(entry) { return `${PRODUCT}/stable/${entry.target}/${entry.arch}/latest/${installerAliasFileName(entry.target, entry.arch)}` }
function rowFor(candidate, entry, url) { return { product: PRODUCT, target: entry.target, arch: entry.arch, version: candidate.version, channel: 'stable', download_url: url(entry.updater.key), signature: entry.signature, notes: candidate.notes, published_at: candidate.createdAt, active: true } }
function latestFor(candidate, entry, url) { return { version: candidate.version, notes: candidate.notes, pub_date: candidate.createdAt, url: url(entry.updater.key), signature: entry.signature, candidate_id: candidate.id } }
function sameLive(live, expected) { return live?.version === expected.version && live?.url === expected.url && live?.signature === expected.signature && live?.candidate_id === expected.candidate_id }
function fingerprint(value) { return digest(JSON.stringify(value)) }

export function createStorage(env = process.env, fetchImpl = fetch) {
  const settings = resolveDesktopReleaseSettings(env)
  const base = new URL(settings.SUPABASE_URL)
  requireCondition(base.protocol === 'https:' && base.hostname === 'spb-bp1f48p09a51z42o.supabase.opentrust.net' && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash && !base.port, 'Configure the main-v2 release project URL')
  requireCondition(safeName(settings.SUPABASE_RELEASE_BUCKET), 'Invalid release bucket')
  const apiKey = env.SUPABASE_STORAGE_API_KEY
  const bucket = settings.SUPABASE_RELEASE_BUCKET
  const url = key => buildPublicStorageUrl({ supabaseUrl: base.href, bucket, key })
  const privateUrl = key => `${base.origin}/storage/v1/object/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
  const headers = () => { requireCondition(apiKey, 'Missing SUPABASE_STORAGE_API_KEY'); return { apikey: apiKey, Authorization: `Bearer ${apiKey}` } }
  const report = (operation, key, started, bytes = 0) => {
    const seconds = (performance.now() - started) / 1000
    console.log(`[storage] ${operation} ${key} ${seconds.toFixed(2)}s${bytes ? ` ${(bytes / 1048576).toFixed(2)} MiB ${(bytes / 1048576 / Math.max(seconds, 0.001)).toFixed(2)} MiB/s` : ''}`)
  }
  async function get(key) {
    const response = await fetchImpl(url(key), { redirect: 'error', cache: 'no-store', headers: { 'cache-control': 'no-cache' } })
    if (response.status === 404) return null
    if (response.status === 400) {
      const body = await response.json().catch(() => null)
      if (String(body?.statusCode) === '404' && body?.error === 'not_found' && body?.message === 'Object not found') return null
      throw new Error(`Storage read failed: HTTP ${response.status}`)
    }
    requireCondition(response.ok, `Storage read failed: HTTP ${response.status}`)
    return response
  }
  return {
    url,
    async getJson(key) {
      const response = await get(key)
      if (!response) return null
      const source = await response.text()
      requireCondition(source.length < 1024 * 1024, 'Oversized release metadata')
      return JSON.parse(source)
    },
    async download(key, destination) {
      const started = performance.now()
      console.log(`[storage] download-start ${key}`)
      const response = await get(key)
      requireCondition(response, 'Candidate object missing')
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
      report('download', key, started, (await stat(destination)).size)
    },
    async put(key, { filePath, content, immutable = false }) {
      const started = performance.now()
      console.log(`[storage] upload-start ${key}`)
      const body = content !== undefined ? Buffer.from(content) : createReadStream(filePath, { highWaterMark: 1024 * 1024 })
      const size = content !== undefined ? body.length : (await stat(filePath)).size
      // Installer aliases inherit metadata on older Storage copy implementations.
      // Keep installers revalidated even at immutable versioned paths, so a copied
      // mutable alias can never inherit a year-long cache lifetime.
      const cacheControl = immutable && !/\.(exe|dmg|AppImage)$/.test(key) ? 'max-age=31536000' : 'max-age=0'
      const response = await fetchImpl(privateUrl(key), { method: 'POST', redirect: 'error', headers: { ...headers(), 'content-type': key.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'content-length': String(size), 'cache-control': cacheControl, 'x-upsert': immutable ? 'false' : 'true' }, body, ...(content === undefined ? { duplex: 'half' } : {}) })
      requireCondition(response.ok, `Storage write failed: HTTP ${response.status} (${immutable ? 'write-once object' : 'mutable pointer'})`)
      await response.body?.cancel()
      report('upload', key, started, size)
    },
    async copy(sourceKey, destinationKey) {
      const started = performance.now()
      const source = await fetchImpl(url(sourceKey), { method: 'HEAD', redirect: 'error', cache: 'no-store' })
      requireCondition(source.ok, `Storage copy source failed: HTTP ${source.status}`)
      const policy = source.headers.get('cache-control') || ''
      if (!(policy === '0' || /(?:^|[,\s])max-age=0(?:$|[,\s])/.test(policy))) return false
      const response = await fetchImpl(`${base.origin}/storage/v1/object/copy`, { method: 'POST', redirect: 'error', headers: { ...headers(), 'content-type': 'application/json', 'x-upsert': 'true' }, body: JSON.stringify({ bucketId: bucket, sourceKey, destinationKey, copyMetadata: false, metadata: { cacheControl: 'max-age=0' } }) })
      // Unsupported copy endpoints fall back to uploading the already verified file.
      if ([404, 405, 501].includes(response.status)) { await response.body?.cancel(); return false }
      requireCondition(response.ok, `Storage copy failed: HTTP ${response.status}`)
      await response.body?.cancel()
      report('server-copy', destinationKey, started)
      return true
    },
    async remove(key) {
      const response = await fetchImpl(privateUrl(key), { method: 'DELETE', redirect: 'error', headers: headers() })
      requireCondition(response.ok, `Storage lock removal failed: HTTP ${response.status}`)
    },
    async publish(row) {
      requireCondition(env.IMAI_RELEASE_PUBLISH_TOKEN, 'Missing IMAI_RELEASE_PUBLISH_TOKEN')
      try { await publishReleaseRow({ supabaseUrl: base.href, releaseToken: env.IMAI_RELEASE_PUBLISH_TOKEN, apiKey, row }, fetchImpl) }
      catch { throw new Error('Release record activation failed; see promotion journal and retry the same candidate') }
    },
  }
}

export async function prepareCandidate(options, { keys = trustedKeys(options.repoRoot), expectedVersion, now = () => new Date().toISOString() } = {}) {
  const version = expectedVersion || await readDesktopReleaseVersion()
  const plan = planRelease(options.tag, version)
  const id = candidateId(options)
  const candidate = { schemaVersion: 1, id, product: PRODUCT, channel: 'stable', ...plan, commit: options.commit, runId: String(options.runId), runAttempt: String(options.runAttempt), engineVersion: await readDeclaredVersion(options.repoRoot || ROOT), validationOnly: false, ready: true, createdAt: now(), notes: 'Uniopc desktop release', entries: [] }
  const uploads = new Map()
  // Verify the complete selected set before the first storage write.
  for (const name of plan.targets) {
    const directory = join(options.artifactsDir, name)
    const allFiles = await filesIn(directory)
    requireCondition(!allFiles.some(value => /build-validation\.json$/.test(value)), 'Validation-only artifacts cannot become release candidates')
    const { target, arch } = targetParts(name)
    const evidence = JSON.parse(await readFile(join(directory, 'signed-build.json'), 'utf8'))
    requireCondition(evidence.validationOnly === false && evidence.releaseBuild === true && evidence.commit === candidate.commit && String(evidence.runId) === candidate.runId && String(evidence.runAttempt) === candidate.runAttempt && evidence.target === target && evidence.arch === arch && evidence.version === version && evidence.engineVersion === candidate.engineVersion && (target !== 'darwin' || evidence.notarized === true), 'Missing or mismatched signed build evidence')
    const supportedFiles = allFiles.filter(value => /\.(app\.tar\.gz|dmg|exe|AppImage)$/.test(value))
    const { updaterPath, installerPath, signaturePath } = pickPlatformArtifacts(target, supportedFiles)
    const selected = [updaterPath, installerPath]
    requireCondition(supportedFiles.every(value => selected.includes(value)), 'Ambiguous candidate artifacts')
    if (target === 'darwin') requireCondition(basename(installerPath).includes(`_${version}_`) || basename(installerPath).includes(`-${version}-`), 'Installer version does not match candidate')
    const signature = (await readFile(signaturePath, 'utf8')).trim()
    await verifyArtifactSignature(updaterPath, signature, keys[target])
    const entry = { name, target, arch, signature, evidence }
    for (const [role, filePath] of [['updater', updaterPath], ['installer', installerPath], ['signatureFile', signaturePath]]) {
      const fileName = basename(filePath)
      const key = fileKey(id, name, fileName)
      entry[role] = { fileName, key, ...await fileInfo(filePath) }
      uploads.set(key, filePath)
    }
    candidate.entries.push(entry)
  }
  return { candidate, uploads }
}

export async function stageCandidate(options, dependencies = {}) {
  const storage = dependencies.storage || createStorage(options.env)
  const keys = dependencies.keys || trustedKeys(options.repoRoot)
  const { candidate, uploads } = await prepareCandidate(options, { ...dependencies, keys })
  // Verify uploaded bytes too. Manifest appears only after every file succeeds.
  const temp = await mkdtemp(join(tmpdir(), 'uniopc-candidate-stage-'))
  try {
    if (dependencies.resumeImmutable) {
      const saved = await storage.getJson(`${prefix(candidate.id)}/candidate.json`)
      if (saved) {
        validateCandidate(saved, candidate.id)
        requireCondition(fingerprint({ ...saved, createdAt: candidate.createdAt }) === fingerprint(candidate), 'Stored candidate differs from the approved files')
        await verifyCandidate(saved, { storage, keys, directory: temp })
        return saved
      }
    }
    let index = 0
    for (const [key, filePath] of uploads) {
      try { await storage.put(key, { filePath, immutable: true }) }
      catch (error) {
        if (!dependencies.resumeImmutable || !/HTTP 409/.test(error.message)) throw error
        const destination = join(temp, `resume-${index++}`)
        await storage.download(key, destination)
        requireCondition(fingerprint(await fileInfo(destination)) === fingerprint(await fileInfo(filePath)), 'Existing immutable candidate bytes differ from approved files')
      }
    }
    await verifyCandidate(candidate, { storage, keys, directory: temp })
    await storage.put(`${prefix(candidate.id)}/candidate.json`, { content: json(candidate), immutable: true })
  }
  finally { await rm(temp, { recursive: true, force: true }) }
  return candidate
}

export function validateCandidate(candidate, id) {
  requireCondition(candidate && candidate.schemaVersion === 1 && candidate.product === PRODUCT && candidate.channel === 'stable' && candidate.id === id && candidate.ready === true && candidate.validationOnly === false, 'Invalid or validation-only candidate')
  requireCondition(candidateId(candidate) === id && stableVersion.test(candidate.engineVersion) && candidate.notes === 'Uniopc desktop release' && Number.isFinite(Date.parse(candidate.createdAt)), 'Invalid candidate provenance')
  const plan = planRelease(candidate.tag, candidate.version)
  requireCondition(candidate.platforms === plan.platforms && JSON.stringify(candidate.targets) === JSON.stringify(plan.targets) && Array.isArray(candidate.entries) && JSON.stringify(candidate.entries.map(entry => entry.name)) === JSON.stringify(plan.targets), 'Incomplete or unexpected candidate targets')
  for (const entry of candidate.entries) {
    const { target, arch } = targetParts(entry.name)
    requireCondition(entry.target === target && entry.arch === arch, 'Invalid candidate target')
    const evidence = entry.evidence
    requireCondition(evidence?.releaseBuild === true && evidence.validationOnly === false && evidence.commit === candidate.commit && String(evidence.runId) === candidate.runId && String(evidence.runAttempt) === candidate.runAttempt && evidence.target === target && evidence.arch === arch && evidence.version === candidate.version && evidence.engineVersion === candidate.engineVersion && (target !== 'darwin' || evidence.notarized === true), 'Invalid signed build evidence')
    for (const role of ['updater', 'installer', 'signatureFile']) {
      const file = entry[role]
      requireCondition(file && safeName(file.fileName) && file.key === fileKey(id, entry.name, file.fileName) && /^[0-9a-f]{64}$/.test(file.sha256) && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0, 'Invalid candidate artifact path or hash')
    }
    const updaterExt = { darwin: '.app.tar.gz', windows: '.exe', linux: '.AppImage' }[target]
    requireCondition(entry.updater.fileName.endsWith(updaterExt) && entry.signatureFile.fileName === `${entry.updater.fileName}.sig`, 'Invalid updater file type')
    requireCondition(target === 'darwin' ? entry.installer.fileName.endsWith('.dmg') && (entry.installer.fileName.includes(`_${candidate.version}_`) || entry.installer.fileName.includes(`-${candidate.version}-`)) : fingerprint(entry.installer) === fingerprint(entry.updater), 'Invalid installer artifact')
  }
}
export async function verifyCandidate(candidate, { storage, keys, directory }) {
  validateCandidate(candidate, candidate.id)
  const local = new Map()
  for (const entry of candidate.entries) {
    for (const role of ['updater', 'installer', 'signatureFile']) {
      const file = entry[role]
      if (!local.has(file.key)) {
        const destination = join(directory, `${local.size}-${file.fileName}`)
        await storage.download(file.key, destination)
        const actual = await fileInfo(destination)
        requireCondition(actual.sha256 === file.sha256 && actual.sizeBytes === file.sizeBytes, 'Candidate artifact hash or size mismatch')
        local.set(file.key, destination)
      }
    }
    requireCondition((await readFile(local.get(entry.signatureFile.key), 'utf8')).trim() === entry.signature, 'Detached signature does not match candidate')
    await verifyArtifactSignature(local.get(entry.updater.key), entry.signature, keys[entry.target])
  }
  return local
}

export async function promoteCandidate(options, { storage = createStorage(options.env), keys = trustedKeys(options.repoRoot), now = () => new Date().toISOString() } = {}) {
  const id = options.candidateId
  const base = prefix(id)
  const candidate = await storage.getJson(`${base}/candidate.json`)
  validateCandidate(candidate, id)
  requireCondition(candidate.version === options.confirmVersion, 'Confirm version must equal the candidate version')
  const directory = await mkdtemp(join(tmpdir(), 'uniopc-candidate-promote-'))
  const journalKey = `${base}/promotion.json`
  let journal
  try {
    const local = await verifyCandidate(candidate, { storage, keys, directory })
    const hash = fingerprint(candidate)
    const saved = await storage.getJson(journalKey)
    requireCondition(!saved || saved.candidateId === id && saved.manifestHash === hash, 'Promotion journal belongs to different candidate bytes')
    const lock = await storage.getJson(LOCK)
    requireCondition(!lock || lock.candidateId === id, 'Another candidate promotion needs recovery before this candidate can proceed')
    const before = {}
    for (const entry of candidate.entries) {
      const live = await storage.getJson(manifestKey(entry))
      const expected = latestFor(candidate, entry, storage.url)
      requireCondition(!live || stableVersion.test(live.version), 'Invalid live version; fail closed')
      requireCondition(!live || compareReleaseVersions(candidate.version, live.version) > 0 || sameLive(live, expected), 'Candidate does not advance stable or another candidate owns this version')
      if (saved && saved.status !== 'complete') requireCondition(sameLive(live, expected) || fingerprint(live) === fingerprint(saved.before[entry.name]), 'Stable changed since interrupted promotion; refusing to overwrite')
      before[entry.name] = live
    }
    if (options.dryRun) return { candidateId: id, version: candidate.version, targets: candidate.targets, dryRun: true, ready: true }
    requireCondition(options.env?.IMAI_RELEASE_PUBLISH_TOKEN || storage.isTestStorage === true, 'Missing IMAI_RELEASE_PUBLISH_TOKEN')
    // A durable write-once lock prevents another candidate taking over a partial run.
    if (!lock) await storage.put(LOCK, { content: json({ candidateId: id }), immutable: true })
    journal = saved || { schemaVersion: 1, candidateId: id, manifestHash: hash, version: candidate.version, before, startedAt: now(), status: 'running', targets: Object.fromEntries(candidate.targets.map(name => [name, { alias: false, record: false, manifest: false }])) }
    journal.status = 'running'
    delete journal.error
    await storage.put(journalKey, { content: json(journal) })
    for (const entry of candidate.entries) {
      const steps = journal.targets[entry.name]
      const expected = latestFor(candidate, entry, storage.url)
      // Re-read just before each target to detect changes outside this workflow.
      const live = await storage.getJson(manifestKey(entry))
      requireCondition(sameLive(live, expected) || fingerprint(live) === fingerprint(journal.before[entry.name]), 'Stable changed during promotion')
      for (const step of ['alias', 'record', 'manifest']) {
        // Retry reconciles all mutable state instead of trusting a possibly stale step bit.
        if (step === 'alias') {
          const copied = storage.copy ? await storage.copy(entry.installer.key, aliasKey(entry)) : false
          if (!copied) await storage.put(aliasKey(entry), { filePath: local.get(entry.installer.key) })
        }
        if (step === 'record') await storage.publish(rowFor(candidate, entry, storage.url))
        if (step === 'manifest') await storage.put(manifestKey(entry), { content: json(expected) })
        steps[step] = true
        journal.updatedAt = now()
        await storage.put(journalKey, { content: json(journal) })
      }
    }
    // Verify live manifests and alias bytes before marking complete.
    for (const entry of candidate.entries) {
      requireCondition(sameLive(await storage.getJson(manifestKey(entry)), latestFor(candidate, entry, storage.url)), 'Live manifest verification failed')
      const aliasPath = join(directory, `alias-${entry.name}`)
      await storage.download(aliasKey(entry), aliasPath)
      requireCondition(fingerprint(await fileInfo(aliasPath)) === fingerprint({ sha256: entry.installer.sha256, sizeBytes: entry.installer.sizeBytes }), 'Live installer alias verification failed')
    }
    journal.status = 'complete'
    journal.completedAt = now()
    await storage.put(journalKey, { content: json(journal) })
    await storage.remove(LOCK)
    return journal
  } catch (error) {
    if (journal) {
      journal.status = 'partial'
      journal.error = error.message
      journal.updatedAt = now()
      await storage.put(journalKey, { content: json(journal) }).catch(() => {})
    }
    throw error
  } finally { await rm(directory, { recursive: true, force: true }) }
}

// Reuse only write-once candidate downloads within this one publication process.
// Both phases still hash/signature-check every file; mutable aliases always get
// a fresh remote read. Standalone/manual promotion never trusts a saved receipt.
export async function publishCandidate(options, dependencies = {}) {
  requireCondition(!options.dryRun, 'Use promote --dry-run to verify an existing candidate without publishing')
  const storage = dependencies.storage || createStorage(options.env)
  const allowedPrefix = `${prefix(candidateId(options))}/`
  const directory = await mkdtemp(join(tmpdir(), 'uniopc-publication-cache-'))
  const cached = new Map()
  const session = {
    ...storage,
    async download(key, destination) {
      if (!key.startsWith(allowedPrefix)) return storage.download(key, destination)
      if (cached.has(key)) return copyFile(cached.get(key), destination, constants.COPYFILE_EXCL)
      await storage.download(key, destination)
      const file = join(directory, String(cached.size))
      await copyFile(destination, file, constants.COPYFILE_EXCL)
      cached.set(key, file)
    },
  }
  try {
    const candidate = await stageCandidate(options, { ...dependencies, storage: session, resumeImmutable: true })
    const promotion = await promoteCandidate({ ...options, candidateId: candidate.id, confirmVersion: candidate.version }, { ...dependencies, storage: session })
    return { candidate, promotion }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function main(argv) {
  const command = argv.shift()
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    requireCondition(flag.startsWith('--'), 'Expected named option')
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (flag === '--dry-run') args.dryRun = true
    else { requireCondition(argv[index + 1] && !argv[index + 1].startsWith('--'), `Missing value for ${flag}`); args[key] = argv[++index] }
  }
  args.env = args.envFile ? { ...process.env, ...await loadEnvFile(args.envFile) } : process.env
  let result
  if (command === 'plan') result = planRelease(args.tag, await readDesktopReleaseVersion())
  else if (command === 'evidence') {
    const catalog = JSON.parse(await readFile(join(args.runtimeDir, 'uniopc-engine-runtime.catalog.json'), 'utf8'))
    const runtimeArch = args.arch === 'aarch64' ? 'arm64' : 'x64'
    const runtimePlatform = args.target === 'windows' ? 'win32' : args.target
    requireCondition(catalog.artifacts?.length === 1 && catalog.artifacts[0].platform === runtimePlatform && catalog.artifacts[0].arch === runtimeArch && catalog.artifacts[0].version === await readDeclaredVersion(), 'Unexpected signed runtime catalog')
    result = { schemaVersion: 1, releaseBuild: true, validationOnly: false, target: args.target, arch: args.arch, version: await readDesktopReleaseVersion(), engineVersion: catalog.artifacts[0].version, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, notarized: args.target === 'darwin' }
    args.output = join(args.bundleDir, 'signed-build.json')
  } else if (command === 'package') result = (await prepareCandidate(args)).candidate
  else if (command === 'stage') result = await stageCandidate(args)
  else if (command === 'publish') result = await publishCandidate(args)
  else if (command === 'promote') result = await promoteCandidate(args)
  else throw new Error('Command must be plan, evidence, package, stage, publish or promote')
  if (args.output) await writeFile(args.output, json(result.candidate || result))
  console.log(json(result))
  if (process.env.GITHUB_STEP_SUMMARY && command === 'package') {
    await import('node:fs/promises').then(fs => fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Internal desktop candidate\nCandidate: \`${result.id}\`\nVersion: ${result.version}\nCommit: ${result.commit}\nTargets: ${result.targets.join(', ')}\nState: internal test packages only; production unchanged. Download the signed bundles in this run's Artifacts section (expires after 3 days).\n`))
  }
  if (process.env.GITHUB_OUTPUT && command === 'plan') {
    await import('node:fs/promises').then(fs => fs.appendFile(process.env.GITHUB_OUTPUT, `platforms=${result.platforms}\nversion=${result.version}\n`))
  }
  if (process.env.GITHUB_STEP_SUMMARY && command === 'publish') {
    await import('node:fs/promises').then(fs => fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Desktop publication\nCandidate: \`${result.candidate.id}\`\nVersion: ${result.candidate.version}\nState: ${result.promotion.status}\n`))
  }
  if (process.env.GITHUB_STEP_SUMMARY && (command === 'stage' || command === 'promote')) {
    await import('node:fs/promises').then(fs => fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Desktop ${command}\nCandidate: \`${result.id || result.candidateId}\`\nVersion: ${result.version}\nState: ${result.status || (result.dryRun ? 'verified, dry run' : 'candidate ready; stable unchanged')}\n`))
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
