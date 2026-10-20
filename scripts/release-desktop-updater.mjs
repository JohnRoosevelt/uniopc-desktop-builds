#!/usr/bin/env node

import { resolveDesktopReleaseSettings } from './desktop-release-settings.mjs'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildReleaseInsertSql,
  prepareDesktopUpdaterRelease,
} from './prepare-desktop-updater-release.mjs'

const PRODUCT = 'imai-desktop'
const DEFAULT_ENV_FILE = '.env.release'

function requireValue(value, name) {
  if (!String(value || '').trim()) {
    throw new Error(`Missing required option: ${name}`)
  }
}

export function compareReleaseVersions(left, right) {
  const parse = (value) => {
    const [core, prerelease = ''] = String(value || '').trim().replace(/^v/i, '').split('-', 2)
    return { core: core.split('.').map(part => Number.parseInt(part, 10) || 0), prerelease }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] || 0) - (b.core[index] || 0)
    if (delta) return delta > 0 ? 1 : -1
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease > b.prerelease ? 1 : -1
}

export function assertPromotionAdvancesVersion({ candidateVersion, publishedVersion }) {
  if (!publishedVersion) return true
  if (compareReleaseVersions(candidateVersion, publishedVersion) <= 0) {
    throw new Error(`Promotion refused: ${candidateVersion} is not newer than published ${publishedVersion}`)
  }
  return true
}

function cleanSegment(value, name) {
  const segment = String(value || '').trim()
  requireValue(segment, name)
  if (segment.includes('/')) {
    throw new Error(`${name} must not contain "/"`)
  }
  return segment
}

export function buildReleaseObjectKey({ product, channel, target, arch, version, fileName }) {
  return [
    cleanSegment(product, 'product'),
    cleanSegment(channel, 'channel'),
    cleanSegment(target, 'target'),
    cleanSegment(arch, 'arch'),
    cleanSegment(version, 'version'),
    cleanSegment(fileName, 'fileName'),
  ].join('/')
}

export function buildLatestInstallerObjectKey({ product, channel, target, arch, fileName }) {
  return [
    cleanSegment(product, 'product'),
    cleanSegment(channel, 'channel'),
    cleanSegment(target, 'target'),
    cleanSegment(arch, 'arch'),
    'latest',
    cleanSegment(fileName, 'fileName'),
  ].join('/')
}

// The client-facing Tauri updater manifest. Published to a PUBLIC Storage key so
// `check()` reads it with zero auth headers — immune to the "baked-in header is
// missing/expired → gateway 401 → auto-update bricked" failure mode that the
// auth-gated /functions/v1/desktop-updater endpoint suffers from.
export function buildLatestManifestObjectKey({ product, channel, target, arch }) {
  return [
    cleanSegment(product, 'product'),
    cleanSegment(channel, 'channel'),
    cleanSegment(target, 'target'),
    cleanSegment(arch, 'arch'),
    'latest.json',
  ].join('/')
}

function latestInstallerFileName({ app, arch }) {
  if (app === 'admin') return `Uniopc_${cleanSegment(arch, 'arch')}.dmg`
  return `${cleanSegment(app, 'app')}_${cleanSegment(arch, 'arch')}.dmg`
}

function encodePathSegments(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

export function buildPublicStorageUrl({ supabaseUrl, bucket, key }) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  return `${base}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodePathSegments(key)}`
}

function releaseConfigFromEnv(env) {
  const settings = resolveDesktopReleaseSettings(env)
  return {
    supabaseUrl: settings.SUPABASE_URL,
    releaseToken: env.IMAI_RELEASE_PUBLISH_TOKEN,
    bucket: settings.SUPABASE_RELEASE_BUCKET,
    storageApiKey: env.SUPABASE_STORAGE_API_KEY || env.SUPABASE_API_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
  }
}

function validateReleaseConfig(config) {
  requireValue(config.supabaseUrl, 'SUPABASE_URL')
  if (new URL(config.supabaseUrl).hostname === 'spb-bp10i1915oj07495.supabase.opentrust.net') {
    throw new Error('The legacy Supabase project is retired; configure the main-v2 release project before publishing')
  }
  requireValue(config.releaseToken, 'IMAI_RELEASE_PUBLISH_TOKEN')
  requireValue(config.bucket, 'SUPABASE_RELEASE_BUCKET')
  requireValue(config.storageApiKey, 'SUPABASE_STORAGE_API_KEY or SUPABASE_API_KEY or SUPABASE_SERVICE_ROLE_KEY')
}

export async function releaseDesktopUpdater(options, deps = defaultDeps) {
  const env = options.env || process.env
  const config = {
    ...releaseConfigFromEnv(env),
    ...options.releaseConfig,
  }
  validateReleaseConfig(config)

  requireValue(options.target, '--target')
  requireValue(options.arch, '--arch')
  requireValue(options.artifactPath, '--artifact')
  requireValue(options.signaturePath, '--signature')

  const app = options.app || 'admin'
  const channel = options.channel || (app === 'employee' ? 'employee' : 'stable')
  const active = options.promote === true

  await assertReadableFile(options.artifactPath, '--artifact')
  await assertReadableFile(options.signaturePath, '--signature')
  if (options.installerPath) await assertReadableFile(options.installerPath, '--installer')

  const prepared = await prepareDesktopUpdaterRelease({
    ...options,
    app,
    channel,
    active,
    downloadUrl: 'https://placeholder.invalid/tauri-updater-artifact',
  })
  if (options.installerPath && options.skipInstallerVersionCheck !== true) {
    validateInstallerVersion({
      installerPath: options.installerPath,
      version: prepared.row.version,
    })
  }

  const artifactKey = buildReleaseObjectKey({
    product: PRODUCT,
    channel,
    target: options.target,
    arch: options.arch,
    version: prepared.row.version,
    fileName: basename(options.artifactPath),
  })
  const signatureKey = buildReleaseObjectKey({
    product: PRODUCT,
    channel,
    target: options.target,
    arch: options.arch,
    version: prepared.row.version,
    fileName: basename(options.signaturePath),
  })
  const installerKey = options.installerPath
    ? buildReleaseObjectKey({
        product: PRODUCT,
        channel,
        target: options.target,
        arch: options.arch,
        version: prepared.row.version,
        fileName: basename(options.installerPath),
      })
    : null
  const installerAliasKey = options.installerPath
    ? buildLatestInstallerObjectKey({
        product: PRODUCT,
        channel,
        target: options.target,
        arch: options.arch,
        fileName: options.installerAliasFileName || latestInstallerFileName({ app, arch: options.arch }),
      })
    : null

  const downloadUrl = buildPublicStorageUrl({
    supabaseUrl: config.supabaseUrl,
    bucket: config.bucket,
    key: artifactKey,
  })
  const signatureUrl = buildPublicStorageUrl({
    supabaseUrl: config.supabaseUrl,
    bucket: config.bucket,
    key: signatureKey,
  })
  const installerUrl = installerKey
    ? buildPublicStorageUrl({
        supabaseUrl: config.supabaseUrl,
        bucket: config.bucket,
        key: installerKey,
      })
    : null
  const installerAliasUrl = installerAliasKey
    ? buildPublicStorageUrl({
        supabaseUrl: config.supabaseUrl,
        bucket: config.bucket,
        key: installerAliasKey,
      })
    : null
  const row = {
    ...prepared.row,
    download_url: downloadUrl,
    active,
  }
  const immutableUploads = [
    { filePath: options.artifactPath, key: artifactKey },
    { filePath: options.signaturePath, key: signatureKey },
  ]
  if (options.installerPath) {
    immutableUploads.push({ filePath: options.installerPath, key: installerKey })
  }

  // Only a promoted (active) release becomes the live auto-update target, so the
  // public manifest is (over)written only then — a staged upload must not hijack
  // clients before it is promoted, matching the DB `active` gate.
  let manifestKey = null
  let manifestUrl = null
  let manifest = null
  if (active) {
    manifestKey = buildLatestManifestObjectKey({
      product: PRODUCT,
      channel,
      target: options.target,
      arch: options.arch,
    })
    manifestUrl = buildPublicStorageUrl({
      supabaseUrl: config.supabaseUrl,
      bucket: config.bucket,
      key: manifestKey,
    })
    manifest = {
      version: row.version,
      notes: row.notes || '',
      pub_date: row.published_at || new Date().toISOString(),
      url: downloadUrl,
      signature: row.signature,
    }
  }

  // Even inactive staging must not overwrite the bytes or deactivate the row
  // of a version already referenced by the live manifest.
  const liveManifestUrl = manifestUrl || buildPublicStorageUrl({
    supabaseUrl: config.supabaseUrl,
    bucket: config.bucket,
    key: buildLatestManifestObjectKey({
      product: PRODUCT, channel, target: options.target, arch: options.arch,
    }),
  })
  const publishedVersion = await (deps.readLatestManifestVersion || readLatestManifestVersion)(liveManifestUrl)
  assertPromotionAdvancesVersion({ candidateVersion: row.version, publishedVersion })

  for (const upload of immutableUploads) {
    await deps.uploadFileToStorage({
      ...config,
      filePath: upload.filePath,
      content: upload.content,
      key: upload.key,
      contentType: upload.contentType || contentTypeForPath(upload.filePath),
    })
  }
  for (const url of [downloadUrl, signatureUrl, installerUrl].filter(Boolean)) {
    await deps.headUrl(url)
  }
  await deps.publishReleaseRow({
    supabaseUrl: config.supabaseUrl,
    releaseToken: config.releaseToken,
    apiKey: config.storageApiKey,
    row,
  })

  // Mutable public pointers move only after the immutable artifact and release
  // record passed their checks. Staged releases intentionally leave both the
  // updater manifest and website installer alias untouched.
  if (active) {
    const mutableUploads = []
    if (options.installerPath) mutableUploads.push({ filePath: options.installerPath, key: installerAliasKey })
    mutableUploads.push({
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      key: manifestKey,
      contentType: 'application/json',
    })
    for (const upload of mutableUploads) {
      await deps.uploadFileToStorage({
        ...config,
        filePath: upload.filePath,
        content: upload.content,
        key: upload.key,
        contentType: upload.contentType || contentTypeForPath(upload.filePath),
      })
    }
    for (const url of [installerAliasUrl, manifestUrl].filter(Boolean)) await deps.headUrl(url)
  }

  return {
    app,
    channel,
    bucket: config.bucket,
    artifactKey,
    signatureKey,
    installerKey,
    installerAliasKey,
    manifestKey,
    signatureUrl,
    installerUrl,
    installerAliasUrl,
    manifestUrl,
    row,
    sql: buildReleaseInsertSql(row),
  }
}

export function validateInstallerVersion({ installerPath, version }) {
  const name = basename(installerPath)
  if (!name.endsWith('.dmg')) return true
  if (!name.includes(`_${version}_`) && !name.includes(`-${version}-`)) {
    throw new Error(
      `Installer file name does not match release version ${version}: ${name}. ` +
      'Pass --skip-installer-version-check only for intentionally versionless installers.',
    )
  }
  return true
}

async function assertReadableFile(path, name) {
  const fileStat = await stat(path).catch((error) => {
    throw new Error(`Cannot read ${name} at ${path}: ${error.message}`)
  })
  if (!fileStat.isFile()) {
    throw new Error(`${name} is not a file: ${path}`)
  }
  if (fileStat.size === 0) {
    throw new Error(`${name} is empty: ${path}`)
  }
  return fileStat
}

function contentTypeForPath(path) {
  if (path.endsWith('.sig')) return 'text/plain'
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (path.endsWith('.msi')) return 'application/x-msi'
  if (path.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable'
  if (path.endsWith('.AppImage')) return 'application/vnd.appimage'
  if (path.endsWith('.deb')) return 'application/vnd.debian.binary-package'
  if (path.endsWith('.rpm')) return 'application/x-rpm'
  if (path.endsWith('.gz') || path.endsWith('.tgz')) return 'application/gzip'
  return 'application/octet-stream'
}

const defaultDeps = {
  uploadFileToStorage,
  headUrl,
  publishReleaseRow,
  readLatestManifestVersion,
}

export async function readLatestManifestVersion(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (response.status === 404) return null
  // This Supabase Storage gateway returns HTTP 400 for a missing public object,
  // while the JSON error body reports the underlying 404.
  if (response.status === 400) {
    const error = await response.json().catch(() => null)
    if (String(error?.statusCode) === '404' && error?.error === 'not_found' && error?.message === 'Object not found') {
      return null
    }
  }
  if (!response.ok) throw new Error(`Cannot read current updater manifest (${response.status})`)
  const manifest = await response.json()
  const version = String(manifest?.version || '').trim()
  if (!version) throw new Error('Current updater manifest has no version')
  return version
}

// Only the big artifacts (dmg / app.tar.gz, tens of MB) get a progress bar;
// small uploads (manifest JSON, .sig) finish instantly and would just add noise.
const UPLOAD_PROGRESS_MIN_BYTES = 1024 * 1024

// Wrap a file read stream in a byte-counting transform that repaints a single
// live stderr line (bar + %, MB done/total, MB/s). Returns a Node Readable that
// `fetch` streams as the request body, so the counted bytes ARE the bytes
// uploaded. Read errors are forwarded so the upload still rejects.
function uploadProgressStream(filePath, total, label) {
  let sent = 0
  let lastPaintAt = 0
  const startedAt = Date.now()
  const width = 24
  const paint = (final = false) => {
    const frac = total > 0 ? Math.min(sent / total, 1) : 0
    const filled = Math.round(frac * width)
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
    const mb = (n) => (n / 1048576).toFixed(1)
    const secs = (Date.now() - startedAt) / 1000
    const speed = secs > 0 ? sent / 1048576 / secs : 0
    process.stderr.write(
      `\r  ↑ ${label}  [${bar}] ${String(Math.round(frac * 100)).padStart(3)}%  ` +
        `${mb(sent)}/${mb(total)} MB  ${speed.toFixed(1)} MB/s${final ? '\n' : '   '}`,
    )
  }
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length
      const now = Date.now()
      if (now - lastPaintAt >= 200) {
        lastPaintAt = now
        paint()
      }
      cb(null, chunk)
    },
    flush(cb) {
      paint(true)
      cb()
    },
  })
  return createReadStream(filePath)
    .on('error', (error) => counter.destroy(error))
    .pipe(counter)
}

export async function uploadFileToStorage({
  supabaseUrl,
  storageApiKey,
  bucket,
  key,
  filePath,
  content,
  contentType,
}) {
  // Accept either an on-disk file (build artifacts) or in-memory content (the
  // generated manifest JSON), so callers do not need a temp file for the latter.
  const inlineBody = content != null ? Buffer.from(content) : null
  const contentLength = inlineBody ? inlineBody.byteLength : (await assertReadableFile(filePath, 'upload file')).size
  const url = new URL(`/storage/v1/object/${encodeURIComponent(bucket)}/${encodePathSegments(key)}`, supabaseUrl)
  const body = inlineBody
    ?? (contentLength >= UPLOAD_PROGRESS_MIN_BYTES
      ? uploadProgressStream(filePath, contentLength, key.split('/').pop() || key)
      : createReadStream(filePath))
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      apikey: storageApiKey,
      Authorization: `Bearer ${storageApiKey}`,
      'content-length': String(contentLength),
      'content-type': contentType,
      'x-upsert': 'true',
    },
    body,
    ...(inlineBody ? {} : { duplex: 'half' }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Storage upload failed for ${key}: HTTP ${response.status} ${body}`.trim())
  }
}

export async function headUrl(url) {
  const response = await fetch(url, { method: 'HEAD' })
  if (!response.ok) {
    throw new Error(`Release artifact is not publicly reachable: HTTP ${response.status} ${url}`)
  }
}

export async function publishReleaseRow({ supabaseUrl, releaseToken, apiKey, row }, fetchImpl = fetch) {
  const url = new URL('/functions/v1/publish-desktop-release', supabaseUrl)
  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: {
      'x-release-token': releaseToken,
      // The Supabase gateway requires apikey/Authorization before the function
      // runs; the function itself authorizes via x-release-token.
      ...(apiKey ? { apikey: apiKey, Authorization: `Bearer ${apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      target: row.target,
      arch: row.arch,
      version: row.version,
      channel: row.channel,
      download_url: row.download_url,
      signature: row.signature,
      notes: row.notes,
      published_at: row.published_at,
      promote: row.active === true,
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Desktop release publish failed: HTTP ${response.status} ${body}`.trim())
  }
}

export async function loadEnvFile(path) {
  const source = await readFile(path, 'utf8')
  const values = {}
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    values[match[1]] = unquoteEnvValue(match[2].trim())
  }
  return values
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

export function parseReleaseArgs(argv) {
  const args = {
    app: 'admin',
    promote: false,
    envFile: resolve(DEFAULT_ENV_FILE),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    switch (arg) {
      case '--app':
        args.app = next
        index += 1
        break
      case '--channel':
        args.channel = next
        index += 1
        break
      case '--target':
        args.target = next
        index += 1
        break
      case '--arch':
        args.arch = next
        index += 1
        break
      case '--artifact':
        args.artifactPath = resolve(next)
        index += 1
        break
      case '--signature':
        args.signaturePath = resolve(next)
        index += 1
        break
      case '--installer':
        args.installerPath = resolve(next)
        index += 1
        break
      case '--installer-alias-file-name':
        args.installerAliasFileName = next
        index += 1
        break
      case '--skip-installer-version-check':
        args.skipInstallerVersionCheck = true
        break
      case '--notes':
        args.notes = next
        index += 1
        break
      case '--published-at':
        args.publishedAt = next
        index += 1
        break
      case '--promote':
        args.promote = true
        break
      case '--env-file':
        args.envFile = resolve(next)
        index += 1
        break
      case '--tauri-config':
        args.tauriConfigPath = resolve(next)
        index += 1
        break
      case '--desktop-package':
        args.desktopPackagePath = resolve(next)
        index += 1
        break
      case '--cargo-toml':
        args.cargoTomlPath = resolve(next)
        index += 1
        break
      case '--help':
        args.help = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return args
}

function usage() {
  return `Usage:
  node scripts/release-desktop-updater.mjs \\
    --app admin \\
    --target darwin \\
    --arch aarch64 \\
    --artifact path/to/Uniopc.app.tar.gz \\
    --signature path/to/Uniopc.app.tar.gz.sig \\
    --installer path/to/Uniopc_0.0.2_aarch64.dmg \\
    --installer-alias-file-name Uniopc_aarch64.dmg \\
    --notes "Release notes" \\
    --env-file .env.release

Required environment:
  IMAI_RELEASE_PUBLISH_TOKEN
  SUPABASE_STORAGE_API_KEY or SUPABASE_API_KEY or SUPABASE_SERVICE_ROLE_KEY

Optional overrides (defaults come from src-tauri/tauri.conf.json):
  SUPABASE_URL
  SUPABASE_RELEASE_BUCKET

The release row is active=false by default. Pass --promote only when this
version should become visible to app updater checks immediately.

Safety escape hatch:
  --skip-installer-version-check
    Only for intentionally versionless installer artifacts; normal release DMGs
    must include the release version in the file name.`
}

async function main() {
  const args = parseReleaseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const fileEnv = args.envFile ? await loadEnvFile(args.envFile) : {}
  const result = await releaseDesktopUpdater({
    ...args,
    env: {
      ...process.env,
      ...fileEnv,
    },
  })

  console.log(JSON.stringify(result.row, null, 2))
  console.log('')
  console.log('-- Supabase release metadata SQL')
  console.log(result.sql)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error)
    console.error('')
    console.error(usage())
    process.exit(1)
  })
}
