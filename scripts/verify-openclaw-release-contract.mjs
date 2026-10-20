#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_DIR = join('src-tauri', 'resources', 'uniopc-engine-runtime')
const CATALOG_NAME = 'uniopc-engine-runtime.catalog.json'
const execFileAsync = promisify(execFile)

export const OPENCLAW_RELEASE_NODE_VERSION = '24.19.0'

function systemTarBin() {
  if (process.platform !== 'win32') return 'tar'
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return join(root, 'System32', 'tar.exe')
}

function canonicalOpenClawPackageEntry(platform) {
  if (platform === 'win32') return 'tools/node/node_modules/uniopc-engine/package.json'
  if (platform === 'darwin' || platform === 'linux') {
    return `tools/node-v${OPENCLAW_RELEASE_NODE_VERSION}/lib/node_modules/uniopc-engine/package.json`
  }
  throw new Error(`Unsupported runtime platform for embedded package verification: ${platform || '<missing>'}`)
}

function canonicalUniopcEngineEntry(packageEntry) {
  return `${dirname(packageEntry)}/uniopc-engine.mjs`
}

export async function readDeclaredVersion(projectRoot = PROJECT_ROOT) {
  const manifestPath = join(projectRoot, 'src-tauri', 'Cargo.toml')
  const manifest = await readFile(manifestPath, 'utf8')
  let inUniopcMetadata = false
  for (const rawLine of manifest.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      inUniopcMetadata = line === '[package.metadata.uniopc]'
      continue
    }
    if (!inUniopcMetadata) continue
    const version = line.match(/^openclaw-version\s*=\s*"([^"]+)"\s*$/)?.[1]
    if (version) return version
  }
  throw new Error(`Missing [package.metadata.uniopc] openclaw-version in ${manifestPath}`)
}

export function selectRuntimeArtifact(catalog, target) {
  const artifact = Array.isArray(catalog?.artifacts)
    ? catalog.artifacts.find((candidate) => (
        candidate?.platform === target?.platform && candidate?.arch === target?.arch
      ))
    : undefined
  if (!artifact) {
    throw new Error(`Missing runtime artifact for ${target?.platform}/${target?.arch}`)
  }
  return artifact
}

export async function verifyArchive(archivePath, artifact) {
  const archiveStat = await stat(archivePath)
  if (archiveStat.size !== artifact.sizeBytes) {
    throw new Error(
      `Runtime archive size mismatch: expected ${artifact.sizeBytes} bytes, found ${archiveStat.size} bytes at ${archivePath}`,
    )
  }

  const expectedSha256 = String(artifact.sha256 || '')
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`Runtime catalog has an invalid SHA-256 for ${archivePath}`)
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archivePath)) hash.update(chunk)
  const actualSha256 = hash.digest('hex')
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Runtime archive SHA-256 mismatch: expected ${expectedSha256}, found ${actualSha256} at ${archivePath}`,
    )
  }

  const packageEntry = canonicalOpenClawPackageEntry(artifact.platform)
  let embeddedPackage
  try {
    const { stdout } = await execFileAsync(
      systemTarBin(),
      ['-xOf', archivePath, packageEntry],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    )
    embeddedPackage = JSON.parse(stdout)
  } catch (error) {
    throw new Error(
      `Runtime archive is missing a readable ${packageEntry}: ${error.message || error}`,
    )
  }
  if (embeddedPackage.name !== 'openclaw') {
    throw new Error(
      `Embedded package name mismatch: expected openclaw, found ${embeddedPackage.name || '<missing>'}`,
    )
  }
  if (embeddedPackage.bin?.['uniopc-engine'] !== 'uniopc-engine.mjs') {
    throw new Error('Embedded package does not expose the branded uniopc-engine executable entry')
  }
  if (embeddedPackage.exports?.['./cli-entry'] !== './uniopc-engine.mjs') {
    throw new Error('Embedded package CLI self-reference does not target uniopc-engine.mjs')
  }
  const entryPath = canonicalUniopcEngineEntry(packageEntry)
  try {
    await execFileAsync(systemTarBin(), ['-xOf', archivePath, entryPath], {
      encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    })
  } catch (error) {
    throw new Error(`Runtime archive is missing ${entryPath}: ${error.message || error}`)
  }
  if (embeddedPackage.version !== artifact.version) {
    throw new Error(
      `Embedded OpenClaw version mismatch: expected ${artifact.version}, found ${embeddedPackage.version || '<missing>'}`,
    )
  }
  return {
    sizeBytes: archiveStat.size,
    sha256: actualSha256,
    embeddedPackage: { name: embeddedPackage.name, version: embeddedPackage.version },
  }
}

export async function verifyReleaseContract(target, {
  projectRoot = PROJECT_ROOT,
  runtimeDirectory,
} = {}) {
  const version = await readDeclaredVersion(projectRoot)
  const runtimeDir = runtimeDirectory ? resolve(runtimeDirectory) : join(projectRoot, RUNTIME_DIR)
  const catalogPath = join(runtimeDir, CATALOG_NAME)
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  const artifact = selectRuntimeArtifact(catalog, target)

  if (artifact.version !== version) {
    throw new Error(
      `Runtime version mismatch: Cargo metadata declares ${version}, catalog has ${artifact.version} for ${target.platform}/${target.arch}`,
    )
  }
  if (artifact.platform !== target.platform || artifact.arch !== target.arch) {
    throw new Error(
      `Runtime target mismatch: expected ${target.platform}/${target.arch}, catalog has ${artifact.platform}/${artifact.arch}`,
    )
  }
  if (artifact.nodeVersion !== OPENCLAW_RELEASE_NODE_VERSION) {
    throw new Error(
      `Runtime Node.js version mismatch: expected ${OPENCLAW_RELEASE_NODE_VERSION}, found ${artifact.nodeVersion || '<missing>'}`,
    )
  }
  if (!artifact.archive || dirname(artifact.archive) !== '.') {
    throw new Error(`Runtime catalog archive must be a file name: ${artifact.archive || '<missing>'}`)
  }

  const archivePath = join(runtimeDir, artifact.archive)
  const verifiedArchive = await verifyArchive(archivePath, artifact)
  return { version, target: { ...target }, artifact, archivePath, verifiedArchive }
}

function parseArgs(argv) {
  const target = { platform: process.platform, arch: process.arch }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--platform' || argument === '--arch') {
      const value = argv[index + 1]
      if (!value) throw new Error(`Missing value for ${argument}`)
      target[argument.slice(2)] = value
      index += 1
    } else if (argument === '--help') {
      return { help: true, target }
    } else {
      throw new Error(`Unknown option: ${argument}`)
    }
  }
  return { help: false, target }
}

function usage() {
  return `Usage:
  node scripts/verify-openclaw-release-contract.mjs [--platform <node-platform> --arch <node-arch>]

Verifies that Cargo metadata, the selected runtime catalog record and its
embedded archive have the same exact release version, platform, architecture,
byte size and SHA-256.`
}

async function main() {
  const { help, target } = parseArgs(process.argv.slice(2))
  if (help) {
    console.log(usage())
    return
  }
  const result = await verifyReleaseContract(target)
  console.log(
    `OpenClaw release contract verified: ${result.version} ${target.platform}/${target.arch} `
      + `${result.verifiedArchive.sizeBytes} bytes ${result.verifiedArchive.sha256}`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error)
    process.exit(1)
  })
}
