import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { planRelease, candidateId, prepareCandidate, stageCandidate, promoteCandidate, publishCandidate, verifyArtifactSignature, createStorage } from './desktop-release-candidate.mjs'
import { isolateBenchmarkStorage } from './benchmark-desktop-publication.mjs'
import { parsePromotionTag, verifyLocalCandidate } from './desktop-candidate-promotion.mjs'

const version = '0.4.13'
const commit = 'a'.repeat(40)
const keys = Object.fromEntries(['darwin', 'windows', 'linux'].map((target, i) => {
  const pair = generateKeyPairSync('ed25519')
  const keyId = Buffer.alloc(8, i + 1)
  const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return [target, { ...pair, keyId, encoded: Buffer.from(`untrusted comment: test public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`).toString('base64') }]
}))
const pubkeys = Object.fromEntries(Object.entries(keys).map(([target, key]) => [target, key.encoded]))
function signature(bytes, target, comment = 'timestamp:1') {
  const key = keys[target]
  const sig = sign(null, createHash('blake2b512').update(bytes).digest(), key.privateKey)
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), key.privateKey)
  return Buffer.from(`untrusted comment: signature\n${Buffer.concat([Buffer.from('ED'), key.keyId, sig]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64')
}
function memoryStorage() {
  const objects = new Map()
  const writes = []
  const rows = []
  return {
    isTestStorage: true, objects, writes, rows,
    fail: null,
    url: key => `https://storage.example/${key}`,
    async getJson(key) { return objects.has(key) ? JSON.parse(objects.get(key).toString()) : null },
    async download(key, destination) { assert.ok(objects.has(key), `Missing test object ${key}`); await writeFile(destination, objects.get(key), { flag: 'wx' }) },
    async put(key, options) {
      if (this.fail?.(key, options)) throw new Error('Injected storage failure')
      if (options.immutable && objects.has(key)) throw new Error('Immutable object exists')
      writes.push({ key, immutable: options.immutable === true })
      objects.set(key, options.content !== undefined ? Buffer.from(options.content) : await readFile(options.filePath))
    },
    async remove(key) { writes.push({ key, removed: true }); objects.delete(key) },
    async publish(row) { if (this.fail?.('record', row)) throw new Error('Injected record failure'); rows.push(structuredClone(row)) },
  }
}
async function fixture(tag = `v${version}`, runAttempt = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'uniopc-candidate-test-'))
  const plan = planRelease(tag)
  for (const name of plan.targets) {
    const target = name.split('-')[0], arch = name.slice(target.length + 1)
    const dest = join(directory, name)
    await mkdir(dest)
    const fileName = target === 'darwin' ? 'Uniopc.app.tar.gz' : target === 'windows' ? `Uniopc_${version}_${arch}-setup.exe` : `Uniopc_${version}_${arch}.AppImage`
    const bytes = Buffer.from(`Release ${version} ${name}`)
    await writeFile(join(dest, fileName), bytes)
    await writeFile(join(dest, `${fileName}.sig`), signature(bytes, target))
    if (target === 'darwin') await writeFile(join(dest, `Uniopc_${version}_${arch}.dmg`), `Installer ${name}`)
    await writeFile(join(dest, 'signed-build.json'), JSON.stringify({ releaseBuild: true, validationOnly: false, commit, runId: '1234', runAttempt: String(runAttempt), target, arch, version, engineVersion: '2026.8.1', notarized: target === 'darwin' }))
  }
  return { tag, commit, runId: '1234', runAttempt: String(runAttempt), artifactsDir: directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}
async function staged(tag) {
  const options = await fixture(tag)
  const storage = memoryStorage()
  try {
    const candidate = await stageCandidate(options, { storage, keys: pubkeys, expectedVersion: version })
    return { options, storage, candidate, promote: { candidateId: candidate.id, confirmVersion: version } }
  } finally { await options.cleanup() }
}
function mutateManifest(storage, candidate, edit) {
  const key = `imai-desktop/candidates/${candidate.id}/candidate.json`
  const copy = structuredClone(candidate)
  edit(copy)
  storage.objects.set(key, Buffer.from(JSON.stringify(copy)))
}
function liveKey(entry) { return `imai-desktop/stable/${entry.target}/${entry.arch}/latest.json` }

test('strict stable tags select exact targets and require consistent versions', () => {
  assert.deepEqual(planRelease(`v${version}`, version).targets, ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'])
  assert.deepEqual(planRelease(`desktop/v${version}`, version).targets, ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'])
  for (const [platform, count] of [['macos', 2], ['windows', 1], ['linux', 1]]) assert.equal(planRelease(`${platform}/v${version}`).targets.length, count)
  for (const tag of ['v01.4.13', 'v0.4.13-test.1', 'windows/v0.4.13-beta', 'arm64/v0.4.13', 'v0.4.13/../other', 'v0.4.13; echo bad']) assert.throws(() => planRelease(tag), /stable tag/)
  assert.throws(() => planRelease('v0.4.12', version), /does not match/)
  assert.notEqual(candidateId({ tag: `v${version}`, commit, runId: 1, runAttempt: 1 }), candidateId({ tag: `v${version}`, commit, runId: 1, runAttempt: 2 }))
})

test('full candidate staging writes only immutable candidate bytes and metadata, never live rows', async () => {
  const { storage, candidate } = await staged(`v${version}`)
  assert.equal(candidate.entries.length, 3)
  assert.equal(storage.rows.length, 0)
  assert.ok(storage.writes.every(write => write.immutable && write.key.includes('/candidates/')))
  assert.ok(storage.writes.at(-1).key.endsWith('/candidate.json'))
})

test('an existing candidate ID and its files cannot be overwritten', async () => {
  const options = await fixture(`windows/v${version}`)
  const storage = memoryStorage()
  try {
    await stageCandidate(options, { storage, keys: pubkeys, expectedVersion: version })
    const before = storage.writes.length
    await assert.rejects(stageCandidate(options, { storage, keys: pubkeys, expectedVersion: version }), /Immutable object exists/)
    assert.equal(storage.writes.length, before)
  } finally { await options.cleanup() }
})

for (const damage of ['missing-target', 'validation', 'signature', 'notarization']) {
  test(`staging ${damage} rejects the whole selected set before any upload`, async () => {
    const options = await fixture(`v${version}`)
    const storage = memoryStorage()
    try {
      const directory = join(options.artifactsDir, 'darwin-x86_64')
      if (damage === 'missing-target') await rm(directory, { recursive: true })
      if (damage === 'validation') await writeFile(join(directory, 'build-validation.json'), '{}')
      if (damage === 'signature') await writeFile(join(directory, 'Uniopc.app.tar.gz'), 'corrupted')
      if (damage === 'notarization') { const file = join(directory, 'signed-build.json'); const evidence = JSON.parse(await readFile(file)); evidence.notarized = false; await writeFile(file, JSON.stringify(evidence)) }
      await assert.rejects(stageCandidate(options, { storage, keys: pubkeys, expectedVersion: version }))
      assert.equal(storage.writes.length, 0)
    } finally { await options.cleanup() }
  })
}

test('crypto verifies the artifact and trusted comment against a platform key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uniopc-signature-test-'))
  try {
    const file = join(directory, 'artifact')
    const bytes = Buffer.from('crypto fixture')
    await writeFile(file, bytes)
    const sig = signature(bytes, 'windows')
    await verifyArtifactSignature(file, sig, pubkeys.windows)
    await assert.rejects(verifyArtifactSignature(file, sig, pubkeys.linux), /key ID/)
    const tampered = Buffer.from(sig, 'base64').toString().replace('timestamp:1', 'timestamp:2')
    await assert.rejects(verifyArtifactSignature(file, Buffer.from(tampered).toString('base64'), pubkeys.windows), /comment verification/)
    await writeFile(file, 'altered')
    await assert.rejects(verifyArtifactSignature(file, sig, pubkeys.windows), /signature verification/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('real Tauri CLI signatures interoperate with candidate crypto verification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uniopc-tauri-signature-test-'))
  try {
    const cli = resolve('node_modules/@tauri-apps/cli/tauri.js')
    const keyPath = join(directory, 'disposable.key')
    const generated = spawnSync(process.execPath, [cli, 'signer', 'generate', '--ci', '--password', '', '--write-keys', keyPath], { encoding: 'utf8', env: { ...process.env, CI: 'true' } })
    assert.equal(generated.status, 0, 'Disposable Tauri test key generation failed')
    const artifact = join(directory, 'artifact')
    await writeFile(artifact, 'real tauri signature')
    const signed = spawnSync(process.execPath, [cli, 'signer', 'sign', artifact], { encoding: 'utf8', env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: (await readFile(keyPath, 'utf8')).trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' } })
    assert.equal(signed.status, 0, 'Disposable Tauri signing failed')
    await verifyArtifactSignature(artifact, (await readFile(`${artifact}.sig`, 'utf8')).trim(), (await readFile(`${keyPath}.pub`, 'utf8')).trim())
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const damage of ['hash', 'signature', 'incomplete', 'validation', 'path', 'old-version', 'same-other-candidate']) {
  test(`promotion refuses ${damage} before any mutable write`, async () => {
    const { storage, candidate, promote } = await staged(`v${version}`)
    const first = candidate.entries[0]
    if (damage === 'hash') storage.objects.set(first.installer.key, Buffer.from('tampered bytes'))
    if (damage === 'signature') mutateManifest(storage, candidate, value => { value.entries[0].signature = value.entries[1].signature })
    if (damage === 'incomplete') mutateManifest(storage, candidate, value => { value.entries.pop() })
    if (damage === 'validation') mutateManifest(storage, candidate, value => { value.validationOnly = true })
    if (damage === 'path') mutateManifest(storage, candidate, value => { value.entries[0].updater.key = 'https://evil.example/secret' })
    if (damage === 'old-version') storage.objects.set(liveKey(first), Buffer.from(JSON.stringify({ version: '0.4.14' })))
    if (damage === 'same-other-candidate') storage.objects.set(liveKey(first), Buffer.from(JSON.stringify({ version, url: 'other', signature: first.signature, candidate_id: 'other' })))
    const before = storage.writes.length
    await assert.rejects(promoteCandidate(promote, { storage, keys: pubkeys }))
    assert.equal(storage.writes.length, before)
    assert.equal(storage.rows.length, 0)
  })
}

test('confirmation mismatch and dry run do not write journal or channels', async () => {
  const { storage, promote } = await staged(`windows/v${version}`)
  const before = storage.writes.length
  await assert.rejects(promoteCandidate({ ...promote, confirmVersion: '0.4.12' }, { storage, keys: pubkeys }), /Confirm version/)
  const result = await promoteCandidate({ ...promote, dryRun: true }, { storage, keys: pubkeys })
  assert.equal(result.ready, true)
  assert.equal(storage.writes.length, before)
})

test('single-platform promotion uses original bytes and URLs and leaves other platforms alone', async () => {
  const { storage, candidate, promote } = await staged(`windows/v${version}`)
  const before = new Map(storage.objects)
  const result = await promoteCandidate(promote, { storage, keys: pubkeys })
  assert.equal(result.status, 'complete')
  assert.equal(storage.rows.length, 1)
  const entry = candidate.entries[0]
  assert.equal(storage.rows[0].download_url, storage.url(entry.updater.key))
  const live = await storage.getJson(liveKey(entry))
  assert.equal(live.signature, entry.signature)
  assert.equal(live.candidate_id, candidate.id)
  const alias = [...storage.objects.keys()].find(key => key.includes('/latest/'))
  assert.deepEqual(storage.objects.get(alias), before.get(entry.installer.key))
  for (const [key, bytes] of before) assert.deepEqual(storage.objects.get(key), bytes, 'Original candidate unchanged')
  assert.ok(storage.writes.filter(write => write.key.includes('/stable/') && !write.key.endsWith('promotion-lock.json')).every(write => write.key.includes('/windows/x86_64/')))
})

test('interrupted multi-target promotion journals progress, locks other candidates and retries identical bytes', async () => {
  const { storage, candidate, promote } = await staged(`v${version}`)
  let failed = false
  storage.fail = key => { if (!failed && key === 'imai-desktop/stable/darwin/x86_64/latest.json') { failed = true; return true } return false }
  await assert.rejects(promoteCandidate(promote, { storage, keys: pubkeys }), /Injected/)
  const journalKey = `imai-desktop/candidates/${candidate.id}/promotion.json`
  const journal = await storage.getJson(journalKey)
  assert.equal(journal.status, 'partial')
  assert.equal(journal.targets['darwin-aarch64'].manifest, true)
  assert.equal(journal.targets['darwin-x86_64'].record, true)
  assert.equal(journal.targets['darwin-x86_64'].manifest, false)
  assert.equal((await storage.getJson('imai-desktop/stable/promotion-lock.json')).candidateId, candidate.id)
  storage.fail = null
  const result = await promoteCandidate(promote, { storage, keys: pubkeys })
  assert.equal(result.status, 'complete')
  assert.equal(await storage.getJson('imai-desktop/stable/promotion-lock.json'), null)
  for (const entry of candidate.entries) assert.equal((await storage.getJson(liveKey(entry))).candidate_id, candidate.id)
  const immutableWrites = storage.writes.filter(write => write.immutable && write.key.includes('/candidates/'))
  assert.equal(new Set(immutableWrites.map(write => write.key)).size, immutableWrites.length)
})

test('a partial run rejects external stable changes instead of silently downgrading', async () => {
  const { storage, candidate, promote } = await staged(`windows/v${version}`)
  storage.fail = key => key.endsWith('/latest.json')
  await assert.rejects(promoteCandidate(promote, { storage, keys: pubkeys }))
  storage.fail = null
  storage.objects.set(liveKey(candidate.entries[0]), Buffer.from(JSON.stringify({ version: '0.4.14' })))
  const before = storage.writes.length
  await assert.rejects(promoteCandidate(promote, { storage, keys: pubkeys }), /does not advance/)
  assert.equal(storage.writes.length, before)
})

test('storage transport enforces write-once objects and redacts server bodies and credentials', async () => {
  const calls = []
  const env = { SUPABASE_URL: 'https://spb-bp1f48p09a51z42o.supabase.opentrust.net', SUPABASE_RELEASE_BUCKET: 'desktop-releases', SUPABASE_STORAGE_API_KEY: 'DO_NOT_LOG' }
  const storage = createStorage(env, async (url, request) => { calls.push({ url, request }); return new Response('DO_NOT_LOG server body', { status: calls.length === 1 ? 200 : 409 }) })
  await storage.put('imai-desktop/candidates/id/candidate.json', { content: '{}', immutable: true })
  assert.equal(calls[0].request.headers['x-upsert'], 'false')
  await assert.rejects(storage.put('imai-desktop/candidates/id/candidate.json', { content: '{}', immutable: true }), error => !error.message.includes('DO_NOT_LOG') && /409/.test(error.message))
  assert.throws(() => createStorage({ ...env, SUPABASE_URL: 'https://evil.example' }), /main-v2/)
})

test('completed promotion rechecks and repairs a corrupted installer alias', async () => {
  const { storage, candidate, promote } = await staged(`windows/v${version}`)
  await promoteCandidate(promote, { storage, keys: pubkeys })
  const alias = 'imai-desktop/stable/windows/x86_64/latest/Uniopc_x86_64-setup.exe'
  storage.objects.set(alias, Buffer.from('corrupted alias'))
  const result = await promoteCandidate(promote, { storage, keys: pubkeys })
  assert.equal(result.status, 'complete')
  assert.deepEqual(storage.objects.get(alias), storage.objects.get(candidate.entries[0].installer.key))
})

test('another candidate cannot take over an interrupted promotion lock', async () => {
  const { storage, candidate, promote } = await staged(`windows/v${version}`)
  storage.objects.set('imai-desktop/stable/promotion-lock.json', Buffer.from(JSON.stringify({ candidateId: 'another-candidate' })))
  const before = storage.writes.length
  await assert.rejects(promoteCandidate(promote, { storage, keys: pubkeys }), /Another candidate/)
  assert.equal(storage.writes.length, before)
  assert.equal(storage.rows.length, 0)
})

test('Storage needs only its existing credential; public settings follow the compiled updater endpoint', async () => {
  const config = JSON.parse(await readFile(resolve('src-tauri/tauri.conf.json'), 'utf8'))
  const endpoint = new URL(config.plugins.updater.endpoints[0])
  const bucket = decodeURIComponent(endpoint.pathname.split('/')[5])
  const calls = []
  const storage = createStorage({ SUPABASE_STORAGE_API_KEY: 'test-only' }, async (url, request) => { calls.push({ url, request }); return new Response('{}', { status: 200 }) })
  assert.equal(storage.url('imai-desktop/candidates/id/candidate.json'), `${endpoint.origin}/storage/v1/object/public/${bucket}/imai-desktop/candidates/id/candidate.json`)
  await storage.put('imai-desktop/candidates/id/candidate.json', { content: '{}', immutable: true })
  assert.equal(calls[0].request.headers['x-upsert'], 'false')
  assert.ok(calls[0].url.startsWith(`${endpoint.origin}/storage/v1/object/${bucket}/`))
})

test('combined publication reads each immutable file once and verifies the copied alias remotely', async () => {
  const options = await fixture(`windows/v${version}`)
  const storage = memoryStorage()
  const downloads = []
  const original = storage.download
  storage.download = async (key, path) => { downloads.push(key); return original(key, path) }
  const copies = []
  storage.copy = async (source, destination) => {
    copies.push({ source, destination })
    storage.objects.set(destination, Buffer.from(storage.objects.get(source)))
    return true
  }
  try {
    const result = await publishCandidate(options, { storage, keys: pubkeys, expectedVersion: version })
    assert.equal(result.promotion.status, 'complete')
    const entry = result.candidate.entries[0]
    assert.equal(downloads.filter(key => key === entry.updater.key).length, 1)
    assert.equal(downloads.filter(key => key === entry.signatureFile.key).length, 1)
    assert.equal(downloads.filter(key => key.includes('/latest/')).length, 1)
    assert.equal(copies.length, 1)
    assert.equal(storage.writes.filter(write => write.key.includes('/latest/')).length, 0)
    // A later manual promotion must not reuse the previous process's cache.
    storage.objects.set(entry.updater.key, Buffer.from('tampered server object'))
    await assert.rejects(promoteCandidate({ candidateId: result.candidate.id, confirmVersion: version }, { storage, keys: pubkeys }), /hash or size mismatch/)
  } finally { await options.cleanup() }
})

test('a corrupted server-side copy cannot be marked complete', async () => {
  const { storage, promote } = await staged(`windows/v${version}`)
  storage.copy = async (source, destination) => { storage.objects.set(destination, Buffer.from('bad copy')); return true }
  await assert.rejects(promoteCandidate(promote, { storage, keys: pubkeys }), /alias verification failed/)
  const journal = await storage.getJson(`imai-desktop/candidates/${promote.candidateId}/promotion.json`)
  assert.equal(journal.status, 'partial')
})

test('copy transport protects mutable download URLs from inherited long cache lifetimes', async () => {
  const env = { SUPABASE_STORAGE_API_KEY: 'DO_NOT_LOG' }
  const requests = []
  let cacheControl = 'max-age=31536000'
  let copyStatus = 200
  const storage = createStorage(env, async (url, request) => {
    requests.push({ url, request })
    if (request.method === 'HEAD') return new Response(null, { headers: { 'cache-control': cacheControl } })
    return new Response('DO_NOT_LOG', { status: copyStatus })
  })
  assert.equal(await storage.copy('source.exe', 'alias.exe'), false)
  assert.equal(requests.length, 1)
  cacheControl = 'max-age=0'
  assert.equal(await storage.copy('source.exe', 'alias.exe'), true)
  const body = JSON.parse(requests.at(-1).request.body)
  assert.equal(body.copyMetadata, false)
  assert.equal(body.metadata.cacheControl, 'max-age=0')
  assert.equal(requests.at(-1).request.headers['x-upsert'], 'true')
  copyStatus = 501
  assert.equal(await storage.copy('source.exe', 'alias.exe'), false)
  copyStatus = 403
  await assert.rejects(storage.copy('source.exe', 'alias.exe'), error => /403/.test(error.message) && !error.message.includes('DO_NOT_LOG'))
})

test('immutable installer uploads retain write-once protection and copy-safe cache headers', async () => {
  const calls = []
  const storage = createStorage({ SUPABASE_STORAGE_API_KEY: 'test' }, async (url, request) => { calls.push(request); return new Response('{}') })
  await storage.put('candidate/installer.exe', { content: 'bytes', immutable: true })
  assert.equal(calls[0].headers['x-upsert'], 'false')
  assert.equal(calls[0].headers['cache-control'], 'max-age=0')
})

test('publication benchmark confines writes, copies, locks and cleanup to its own prefix', async () => {
  const storage = memoryStorage()
  const copies = []
  storage.copy = async (source, destination) => { copies.push({ source, destination }); return true }
  const isolated = isolateBenchmarkStorage(storage, 'windows-test-1')
  const key = 'imai-desktop/stable/windows/x86_64/latest.json'
  await isolated.put(key, { content: '{}' })
  assert.equal(storage.objects.has(key), false)
  assert.deepEqual(await isolated.getJson(key), {})
  await isolated.copy('imai-desktop/candidates/id/setup.exe', key)
  assert.ok(copies.every(c => Object.values(c).every(v => v.startsWith('imai-desktop/benchmarks/windows-test-1/'))))
  await isolated.publish({ version: 'anything' })
  assert.equal(storage.rows.length, 0)
  await assert.rejects(isolated.put('imai-desktop/../escape', { content: '{}' }), /Unsafe benchmark key/)
  await isolated.cleanup()
  assert.equal(storage.objects.size, 0)
})

test('private test candidates bind signed production bytes without any cloud storage operation', async () => {
  const options = await fixture(`test/windows/v${version}-2`)
  try {
    const { candidate, uploads } = await prepareCandidate(options, { keys: pubkeys, expectedVersion: version })
    assert.equal(candidate.version, version)
    assert.equal(candidate.tag, options.tag)
    assert.equal(uploads.size, 2, 'Windows installer/updater uses one shared binary plus its signature')
    const request = parsePromotionTag(`publish/${candidate.id}`)
    const deps = { artifactsDir: options.artifactsDir, request, commit, sourceTag: options.tag, keys: pubkeys }
    assert.equal((await verifyLocalCandidate(candidate, deps)).id, candidate.id)
    await assert.rejects(verifyLocalCandidate(candidate, { ...deps, request: { ...request, runAttempt: '9' } }), /approved build/)
    await writeFile(join(options.artifactsDir, candidate.entries[0].name, candidate.entries[0].installer.fileName), 'modified after internal testing')
    await assert.rejects(verifyLocalCandidate(candidate, deps), /hash\/size mismatch/)
  } finally { await options.cleanup() }
})

test('test tags require numbered builds and never change the application version', () => {
  assert.deepEqual(planRelease(`test/windows/v${version}-3`, version).targets, ['windows-x86_64'])
  assert.equal(planRelease(`test/v${version}-1`, version).version, version)
  for (const tag of [`test/windows/v${version}`, `test/windows/v${version}-0`, `test/windows/v${version}-01`, `test/windows/v${version}-rc.1`]) assert.throws(() => planRelease(tag, version))
})
test('approval verifies native NSIS subdirectories and rejects ambiguous installer basenames', async () => {
  const options = await fixture(`test/windows/v${version}-1`)
  try {
    const { candidate } = await prepareCandidate(options, { keys: pubkeys, expectedVersion: version })
    const entry = candidate.entries[0], directory = join(options.artifactsDir, entry.name)
    await mkdir(join(directory, 'nsis'))
    for (const file of [entry.installer, entry.signatureFile]) await rename(join(directory, file.fileName), join(directory, 'nsis', file.fileName))
    const deps = { artifactsDir: options.artifactsDir, request: parsePromotionTag(`publish/${candidate.id}`), commit, sourceTag: options.tag, keys: pubkeys }
    await verifyLocalCandidate(candidate, deps)
    await writeFile(join(directory, entry.installer.fileName), 'duplicate installer')
    await assert.rejects(verifyLocalCandidate(candidate, deps), /missing or ambiguous/)
  } finally { await options.cleanup() }
})

test('an interrupted explicit publication resumes identical immutable bytes without uploading them again', async () => {
  const options = await fixture(`test/windows/v${version}-1`)
  const storage = memoryStorage()
  try {
    storage.fail = key => key.endsWith('/latest.json')
    await assert.rejects(publishCandidate(options, { storage, keys: pubkeys, expectedVersion: version }), /Injected/)
    const immutableBefore = storage.writes.filter(w => w.immutable && w.key.includes('/candidates/')).length
    storage.fail = null
    const result = await publishCandidate(options, { storage, keys: pubkeys, expectedVersion: version })
    assert.equal(result.promotion.status, 'complete')
    assert.equal(storage.writes.filter(w => w.immutable && w.key.includes('/candidates/')).length, immutableBefore)
  } finally { await options.cleanup() }
})
