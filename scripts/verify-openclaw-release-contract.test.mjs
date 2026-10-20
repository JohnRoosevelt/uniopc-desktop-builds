import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  selectRuntimeArtifact,
  verifyArchive,
  verifyReleaseContract,
} from './verify-openclaw-release-contract.mjs'

const TARGET = { platform: 'win32', arch: 'x64' }
const ARCHIVE_NAME = 'uniopc-engine-runtime-win32-x64.tar.gz'
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function systemTarBin() {
  if (process.platform !== 'win32') return 'tar'
  return join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tar.exe')
}

async function writeReleaseFixture({
  target = TARGET,
  declaredVersion = '2026.8.1',
  artifactVersion = declaredVersion,
  embeddedName = 'openclaw',
  embeddedVersion = artifactVersion,
  nodeVersion = '24.19.0',
  packageEntry = target.platform === 'win32'
    ? 'tools/node/node_modules/uniopc-engine/package.json'
    : `tools/node-v${nodeVersion}/lib/node_modules/uniopc-engine/package.json`,
  includeBrandedEntry = true,
} = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'uniopc-openclaw-contract-'))
  const runtimeDir = join(projectRoot, 'src-tauri', 'resources', 'uniopc-engine-runtime')
  const archiveRoot = join(projectRoot, 'archive-root')
  const packagePath = join(archiveRoot, ...packageEntry.split('/'))
  const packageDir = dirname(packagePath)
  await mkdir(runtimeDir, { recursive: true })
  await mkdir(join(archiveRoot, 'tools'), { recursive: true })
  await mkdir(packageDir, { recursive: true })
  await writeFile(
    packagePath,
    `${JSON.stringify({
      name: embeddedName,
      version: embeddedVersion,
      bin: { 'uniopc-engine': 'uniopc-engine.mjs' },
      exports: { './cli-entry': './uniopc-engine.mjs' },
    })}\n`,
  )
  if (includeBrandedEntry) await writeFile(join(packageDir, 'uniopc-engine.mjs'), '#!/usr/bin/env node\n')
  const archiveName = `uniopc-engine-runtime-${target.platform}-${target.arch}.tar.gz`
  const archivePath = join(runtimeDir, archiveName)
  const archiveEntries = [...new Set(['tools', packageEntry.split('/')[0]])]
  const packed = spawnSync(systemTarBin(), ['-czf', archivePath, '-C', archiveRoot, ...archiveEntries], {
    encoding: 'utf8',
  })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  const archiveBytes = await readFile(archivePath)
  await writeFile(
    join(projectRoot, 'src-tauri', 'Cargo.toml'),
    `[package]\nname = "fixture"\n\n[package.metadata.uniopc]\nopenclaw-version = "${declaredVersion}"\n`,
  )
  await writeFile(
    join(runtimeDir, 'uniopc-engine-runtime.catalog.json'),
    `${JSON.stringify({
      artifacts: [{
        version: artifactVersion,
        ...target,
        archive: archiveName,
        sha256: sha256(archiveBytes),
        sizeBytes: archiveBytes.length,
        nodeVersion,
      }],
    })}\n`,
  )
  return { projectRoot, runtimeDir, archiveBytes, archiveName }
}

test('rejects a target artifact whose version differs from Cargo metadata', async () => {
  const fixture = await writeReleaseFixture({ artifactVersion: '2026.9.1' })

  await assert.rejects(
    verifyReleaseContract(TARGET, { projectRoot: fixture.projectRoot }),
    /version mismatch.*2026\.8\.1.*2026\.9\.1/i,
  )
})

test('rejects a catalog without the requested platform and architecture', () => {
  assert.throws(
    () => selectRuntimeArtifact({ artifacts: [] }, TARGET),
    /missing runtime artifact.*win32\/x64/i,
  )
})

test('rejects an archive whose byte size differs from the catalog', async () => {
  const fixture = await writeReleaseFixture()
  const archivePath = join(fixture.runtimeDir, ARCHIVE_NAME)

  await assert.rejects(
    verifyArchive(archivePath, {
      sizeBytes: fixture.archiveBytes.length + 1,
      sha256: sha256(fixture.archiveBytes),
    }),
    /size mismatch/i,
  )
})

test('rejects an archive whose SHA-256 differs from the catalog', async () => {
  const fixture = await writeReleaseFixture()
  const archivePath = join(fixture.runtimeDir, ARCHIVE_NAME)

  await assert.rejects(
    verifyArchive(archivePath, {
      sizeBytes: fixture.archiveBytes.length,
      sha256: '0'.repeat(64),
    }),
    /SHA-256 mismatch/i,
  )
})

test('rejects an archive whose embedded OpenClaw version differs from the catalog', async () => {
  const fixture = await writeReleaseFixture({ embeddedVersion: '2026.8.2' })

  await assert.rejects(
    verifyReleaseContract(TARGET, { projectRoot: fixture.projectRoot }),
    /embedded OpenClaw version mismatch.*2026\.8\.1.*2026\.8\.2/i,
  )
})

test('rejects an archive whose embedded package identity is not OpenClaw', async () => {
  const fixture = await writeReleaseFixture({ embeddedName: 'not-openclaw' })

  await assert.rejects(
    verifyReleaseContract(TARGET, { projectRoot: fixture.projectRoot }),
    /embedded package name mismatch.*openclaw.*not-openclaw/i,
  )
})

test('requires the branded CLI manifest entry and script in the archive', async () => {
  const fixture = await writeReleaseFixture({ includeBrandedEntry: false })
  await assert.rejects(
    verifyReleaseContract(TARGET, { projectRoot: fixture.projectRoot }),
    /missing .*uniopc-engine\.mjs/i,
  )
})

test('accepts the canonical Unix package entry for the exact Node release', async () => {
  for (const target of [
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'x64' },
  ]) {
    const fixture = await writeReleaseFixture({ target })
    const result = await verifyReleaseContract(target, { projectRoot: fixture.projectRoot })

    assert.equal(result.verifiedArchive.embeddedPackage.version, '2026.8.1')
  }
})

test('Unix artifacts reject alias, arbitrary, and wrong-Node package entries', async () => {
  const target = { platform: 'darwin', arch: 'arm64' }
  for (const packageEntry of [
    'tools/node/lib/node_modules/uniopc-engine/package.json',
    'vendor/uniopc-engine/package.json',
    'tools/node-v24.19.1/lib/node_modules/uniopc-engine/package.json',
  ]) {
    const fixture = await writeReleaseFixture({ target, packageEntry })
    await assert.rejects(
      verifyReleaseContract(target, { projectRoot: fixture.projectRoot }),
      /missing a readable tools\/node-v24\.19\.0\/lib\/node_modules\/uniopc-engine\/package\.json/i,
    )
  }
})

test('Windows artifacts reject the Unix package entry', async () => {
  const fixture = await writeReleaseFixture({
    packageEntry: 'tools/node-v24.19.0/lib/node_modules/uniopc-engine/package.json',
  })
  await assert.rejects(
    verifyReleaseContract(TARGET, { projectRoot: fixture.projectRoot }),
    /missing a readable tools\/node\/node_modules\/uniopc-engine\/package\.json/i,
  )
})

test('rejects a catalog Node version adjacent to the exact release runtime', async () => {
  for (const nodeVersion of ['24.18.0', '24.19.1']) {
    const fixture = await writeReleaseFixture({ nodeVersion })
    await assert.rejects(
      verifyReleaseContract(TARGET, { projectRoot: fixture.projectRoot }),
      /Node\.js version mismatch.*24\.19\.0/i,
    )
  }
})

test('accepts an exact target, version, size and SHA-256 tuple', async () => {
  const fixture = await writeReleaseFixture()

  const result = await verifyReleaseContract(TARGET, { projectRoot: fixture.projectRoot })

  assert.equal(result.version, '2026.8.1')
  assert.equal(result.artifact.archive, ARCHIVE_NAME)
  assert.equal(result.archivePath, join(fixture.runtimeDir, ARCHIVE_NAME))
})

test('verifies a prepared runtime directory without selecting workspace runtime bytes', async () => {
  const fixture = await writeReleaseFixture()
  const preparedRuntimeDirectory = join(fixture.projectRoot, 'prepared-runtime')
  await mkdir(preparedRuntimeDirectory)
  await writeFile(join(preparedRuntimeDirectory, fixture.archiveName), fixture.archiveBytes)
  await writeFile(
    join(preparedRuntimeDirectory, 'uniopc-engine-runtime.catalog.json'),
    await readFile(join(fixture.runtimeDir, 'uniopc-engine-runtime.catalog.json')),
  )
  await rm(fixture.runtimeDir, { recursive: true, force: true })

  const result = await verifyReleaseContract(TARGET, {
    projectRoot: fixture.projectRoot,
    runtimeDirectory: preparedRuntimeDirectory,
  })

  assert.equal(result.archivePath, join(preparedRuntimeDirectory, fixture.archiveName))
})

test('exposes the verifier through the documented npm command', () => {
  const result = spawnSync('npm run verify:openclaw-contract -- --help', {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    shell: true,
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /verify-openclaw-release-contract\.mjs/)
  assert.match(result.stdout, /Usage:/)
})
