import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildReleaseInsertSql,
  prepareDesktopUpdaterRelease,
  readDesktopReleaseVersion,
  readTauriConfig,
  validateUpdaterConfig,
} from './prepare-desktop-updater-release.mjs'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Windows layered Tauri config resolves to the shared desktop release version', async () => {
  const desktopPackage = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
  const version = await readDesktopReleaseVersion({
    desktopPackagePath: join(desktopRoot, 'package.json'),
    cargoTomlPath: join(desktopRoot, 'src-tauri', 'Cargo.toml'),
    tauriConfigPath: join(desktopRoot, 'src-tauri', 'tauri.windows.conf.json'),
  })

  assert.equal(version, desktopPackage.version)
})

test('Windows layered Tauri config builds the NSIS installer only', async () => {
  const config = await readTauriConfig(
    join(desktopRoot, 'src-tauri', 'tauri.windows.conf.json'),
  )

  assert.deepEqual(config.bundle.targets, ['nsis'])
})

test('validateUpdaterConfig rejects the placeholder updater public key', () => {
  assert.throws(
    () =>
      validateUpdaterConfig({
        plugins: {
          updater: {
            pubkey: 'REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY',
            endpoints: ['https://api.imai.app/functions/v1/desktop-updater/{{target}}/{{arch}}/{{current_version}}?channel=stable'],
          },
        },
      }),
    /updater public key is still the placeholder/,
  )
})

test('prepareDesktopUpdaterRelease builds Supabase metadata from signed artifact inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imai-updater-release-'))
  const desktopPackagePath = join(root, 'package.json')
  const cargoTomlPath = join(root, 'Cargo.toml')
  const tauriConfigPath = join(root, 'tauri.conf.json')
  const signaturePath = join(root, 'Uniopc.app.tar.gz.sig')

  await writeFile(desktopPackagePath, JSON.stringify({ version: '0.0.2' }))
  await writeFile(cargoTomlPath, '[package]\nname = "uniopc"\nversion = "0.0.2"\n')
  await writeFile(
    tauriConfigPath,
    JSON.stringify({
      productName: 'Uniopc',
      version: '0.0.2',
      plugins: {
        updater: {
          pubkey: 'real-tauri-updater-public-key',
          endpoints: ['https://api.imai.app/functions/v1/desktop-updater/{{target}}/{{arch}}/{{current_version}}?channel=stable'],
        },
      },
    }),
  )
  await writeFile(signaturePath, ' signed-update-signature \n')

  const release = await prepareDesktopUpdaterRelease({
    app: 'admin',
    channel: 'stable',
    target: 'darwin',
    arch: 'aarch64',
    downloadUrl: 'https://cdn.example.com/Uniopc_0.0.2_aarch64.app.tar.gz',
    notes: 'Bug fixes',
    publishedAt: '2026-05-19T12:00:00.000Z',
    desktopPackagePath,
    cargoTomlPath,
    tauriConfigPath,
    signaturePath,
  })

  assert.deepEqual(release.row, {
    product: 'imai-desktop',
    target: 'darwin',
    arch: 'aarch64',
    version: '0.0.2',
    channel: 'stable',
    download_url: 'https://cdn.example.com/Uniopc_0.0.2_aarch64.app.tar.gz',
    signature: 'signed-update-signature',
    notes: 'Bug fixes',
    published_at: '2026-05-19T12:00:00.000Z',
    active: false,
  })
  assert.match(release.sql, /insert into public\.desktop_app_releases/)
  assert.match(release.sql, /'signed-update-signature'/)
  assert.match(release.sql, /active\)/)
  assert.match(release.sql, /false\)/)
})

test('readDesktopReleaseVersion returns the shared desktop version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imai-release-version-'))
  const desktopPackagePath = join(root, 'package.json')
  const cargoTomlPath = join(root, 'Cargo.toml')
  const tauriConfigPath = join(root, 'tauri.conf.json')

  await writeFile(desktopPackagePath, JSON.stringify({ version: '0.1.8' }))
  await writeFile(cargoTomlPath, '[package]\nname = "uniopc"\nversion = "0.1.8"\n')
  await writeFile(tauriConfigPath, JSON.stringify({ version: '0.1.8' }))

  const version = await readDesktopReleaseVersion({
    desktopPackagePath,
    cargoTomlPath,
    tauriConfigPath,
  })

  assert.equal(version, '0.1.8')
})

test('readDesktopReleaseVersion rejects mismatched desktop versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imai-release-version-mismatch-'))
  const desktopPackagePath = join(root, 'package.json')
  const cargoTomlPath = join(root, 'Cargo.toml')
  const tauriConfigPath = join(root, 'tauri.conf.json')

  await writeFile(desktopPackagePath, JSON.stringify({ version: '0.1.8' }))
  await writeFile(cargoTomlPath, '[package]\nname = "uniopc"\nversion = "0.1.7"\n')
  await writeFile(tauriConfigPath, JSON.stringify({ version: '0.1.8' }))

  await assert.rejects(
    () => readDesktopReleaseVersion({
      desktopPackagePath,
      cargoTomlPath,
      tauriConfigPath,
    }),
    /Desktop version mismatch/,
  )
})

test('prepareDesktopUpdaterRelease rejects removed independent app releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imai-updater-release-independent-'))
  const desktopPackagePath = join(root, 'package.json')
  const cargoTomlPath = join(root, 'Cargo.toml')
  const tauriConfigPath = join(root, 'tauri.conf.json')
  const signaturePath = join(root, 'Uniopc Employee.app.tar.gz.sig')

  await writeFile(desktopPackagePath, JSON.stringify({ version: '0.0.4' }))
  await writeFile(cargoTomlPath, '[package]\nname = "uniopc"\nversion = "0.0.4"\n')
  await writeFile(
    tauriConfigPath,
    JSON.stringify({
      productName: 'Uniopc Employee',
      version: '0.1.0',
      plugins: {
        updater: {
          pubkey: 'real-tauri-updater-public-key',
          endpoints: ['https://api.imai.app/functions/v1/desktop-updater/{{target}}/{{arch}}/{{current_version}}?channel=employee'],
        },
      },
    }),
  )
  await writeFile(signaturePath, 'employee-signature')

  await assert.rejects(
    () => prepareDesktopUpdaterRelease({
      app: 'employee',
      target: 'darwin',
      arch: 'aarch64',
      downloadUrl: 'https://cdn.example.com/Uniopc%20Employee.app.tar.gz',
      desktopPackagePath,
      cargoTomlPath,
      tauriConfigPath,
      signaturePath,
    }),
    /Only "admin" is currently supported/,
  )
})

test('buildReleaseInsertSql escapes string values', () => {
  const sql = buildReleaseInsertSql({
    product: 'imai-desktop',
    target: 'darwin',
    arch: 'aarch64',
    version: '0.0.2',
    channel: 'stable',
    download_url: "https://cdn.example.com/imai's.tar.gz",
    signature: "sig'value",
    notes: "owner's notes",
    published_at: '2026-05-19T12:00:00.000Z',
    active: false,
  })

  assert.match(sql, /imai''s\.tar\.gz/)
  assert.match(sql, /sig''value/)
  assert.match(sql, /owner''s notes/)
})
