#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLACEHOLDER_PUBKEY = 'REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY'
const PRODUCT = 'imai-desktop'

function scriptDir() {
  return dirname(fileURLToPath(import.meta.url))
}

function repoRoot() {
  return resolve(scriptDir(), '..')
}

function defaultPaths(app) {
  const root = repoRoot()
  return {
    desktopPackagePath: resolve(root, 'package.json'),
    cargoTomlPath: resolve(root, 'src-tauri/Cargo.toml'),
    tauriConfigPath: resolve(root, 'src-tauri/tauri.conf.json'),
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function mergeTauriConfig(base, override) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = mergeTauriConfig(merged[key], value)
    } else {
      merged[key] = value
    }
  }
  return merged
}

export async function readTauriConfig(path) {
  const override = await readJson(path)
  if (!/^tauri\.[^.]+\.conf\.json$/.test(basename(path))) return override

  const base = await readJson(resolve(dirname(path), 'tauri.conf.json'))
  return mergeTauriConfig(base, override)
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '')
}

function requireValue(value, name) {
  if (!String(value || '').trim()) {
    throw new Error(`Missing required option: ${name}`)
  }
}

function readCargoPackageVersion(source) {
  let inPackage = false
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\[package\]\s*$/.test(line)) {
      inPackage = true
      continue
    }
    if (inPackage && /^\s*\[/.test(line)) break
    if (inPackage) {
      const versionMatch = line.match(/^\s*version\s*=\s*"([^"]+)"/)
      if (versionMatch) return normalizeVersion(versionMatch[1])
    }
  }
  return ''
}

export async function readDesktopReleaseVersion(options = {}) {
  const app = options.app || 'admin'
  assertSupportedApp(app)

  const paths = {
    ...defaultPaths(app),
    // Callers (e.g. ci-publish) may pass path keys through as explicit
    // `undefined`; filter those out so they never clobber the defaults.
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  }

  const [desktopPackage, cargoToml, tauriConfig] = await Promise.all([
    readJson(paths.desktopPackagePath),
    readFile(paths.cargoTomlPath, 'utf8'),
    readTauriConfig(paths.tauriConfigPath),
  ])

  const versions = {
    'package.json': normalizeVersion(desktopPackage.version),
    'src-tauri/Cargo.toml': readCargoPackageVersion(cargoToml),
    'src-tauri/tauri.conf.json': normalizeVersion(tauriConfig.version),
  }

  for (const [source, version] of Object.entries(versions)) {
    requireValue(version, `${source} version`)
  }

  const uniqueVersions = [...new Set(Object.values(versions))]
  if (uniqueVersions.length > 1) {
    const details = Object.entries(versions)
      .map(([source, version]) => `${source}=${version}`)
      .join(', ')
    throw new Error(`Desktop version mismatch: ${details}`)
  }

  return uniqueVersions[0]
}

function assertSupportedApp(app) {
  if (app !== 'admin') {
    throw new Error(`Unsupported app "${app}". Only "admin" is currently supported.`)
  }
}

export function validateUpdaterConfig(config) {
  const updater = config?.plugins?.updater
  if (!updater) {
    throw new Error('Tauri updater config is missing plugins.updater')
  }

  const pubkey = String(updater.pubkey || '').trim()
  if (!pubkey) {
    throw new Error('Tauri updater public key is missing')
  }
  if (pubkey === PLACEHOLDER_PUBKEY) {
    throw new Error('Tauri updater public key is still the placeholder')
  }

  const endpoints = Array.isArray(updater.endpoints) ? updater.endpoints : []
  if (endpoints.length === 0) {
    throw new Error('Tauri updater endpoints are missing')
  }
  for (const endpoint of endpoints) {
    // Static manifest endpoints (…/{{target}}/{{arch}}/latest.json served from a
    // public Storage bucket) do not need {{current_version}}: Tauri compares the
    // manifest version against the running app client-side. Only the per-platform
    // path tokens are mandatory.
    for (const token of ['{{target}}', '{{arch}}']) {
      if (!String(endpoint).includes(token)) {
        throw new Error(`Tauri updater endpoint is missing ${token}: ${endpoint}`)
      }
    }
  }

  return true
}

export async function prepareDesktopUpdaterRelease(options) {
  const app = options.app || 'admin'
  assertSupportedApp(app)

  const channel = options.channel || 'stable'
  const paths = {
    ...defaultPaths(app),
    // Callers (e.g. ci-publish) may pass path keys through as explicit
    // `undefined`; filter those out so they never clobber the defaults.
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  }

  requireValue(options.target, '--target')
  requireValue(options.arch, '--arch')
  requireValue(options.downloadUrl, '--download-url')
  requireValue(options.signaturePath, '--signature')

  const [tauriConfig, signatureSource, version] = await Promise.all([
    readTauriConfig(paths.tauriConfigPath),
    readFile(paths.signaturePath, 'utf8'),
    readDesktopReleaseVersion(paths),
  ])

  validateUpdaterConfig(tauriConfig)

  const signature = signatureSource.trim()
  if (!signature) {
    throw new Error(`Signature file is empty: ${paths.signaturePath}`)
  }

  const row = {
    product: PRODUCT,
    target: options.target,
    arch: options.arch,
    version,
    channel,
    download_url: options.downloadUrl,
    signature,
    notes: options.notes || '',
    published_at: options.publishedAt || new Date().toISOString(),
    active: options.active === true,
  }

  return {
    app,
    configPath: paths.tauriConfigPath,
    row,
    sql: buildReleaseInsertSql(row),
  }
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return `'${String(value).replaceAll("'", "''")}'`
}

export function buildReleaseInsertSql(row) {
  const columns = [
    'product',
    'target',
    'arch',
    'version',
    'channel',
    'download_url',
    'signature',
    'notes',
    'published_at',
    'active',
  ]
  const values = columns.map((column) => sqlValue(row[column])).join(', ')

  return `insert into public.desktop_app_releases (${columns.join(', ')})
values (${values})
on conflict (product, target, arch, version, channel) do update set
  download_url = excluded.download_url,
  signature = excluded.signature,
  notes = excluded.notes,
  published_at = excluded.published_at,
  active = excluded.active;`
}

function parseArgs(argv) {
  const args = {
    app: 'admin',
    active: false,
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
      case '--download-url':
        args.downloadUrl = next
        index += 1
        break
      case '--signature':
        args.signaturePath = resolve(next)
        index += 1
        break
      case '--notes':
        args.notes = next
        index += 1
        break
      case '--published-at':
        args.publishedAt = next
        index += 1
        break
      case '--active':
        args.active = true
        break
      case '--print-version':
        args.printVersion = true
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
  node scripts/prepare-desktop-updater-release.mjs --print-version

  node scripts/prepare-desktop-updater-release.mjs \\
    --app admin \\
    --target darwin \\
    --arch aarch64 \\
    --download-url https://cdn.example.com/Uniopc_0.0.2_aarch64.app.tar.gz \\
    --signature path/to/Uniopc.app.tar.gz.sig \\
    --notes "Release notes"

By default the generated Supabase row uses active=false. Pass --active only when
you intentionally want the generated SQL to enable the release immediately.`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (args.printVersion) {
    const version = await readDesktopReleaseVersion(args)
    console.log(version)
    return
  }

  const release = await prepareDesktopUpdaterRelease(args)
  console.log(JSON.stringify(release.row, null, 2))
  console.log('')
  console.log('-- Supabase release metadata SQL')
  console.log(release.sql)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error)
    console.error('')
    console.error(usage())
    process.exit(1)
  })
}
