import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  ciPublishDesktopArtifacts,
  installerAliasFileName,
  pickPlatformArtifacts,
} from './ci-publish-desktop-artifacts.mjs'

test('pickPlatformArtifacts resolves macOS updater, installer and derived signature', () => {
  const picked = pickPlatformArtifacts('darwin', [
    '/b/dmg/Uniopc_0.4.6_universal.dmg',
    '/b/macos/Uniopc.app.tar.gz',
    '/b/macos/Uniopc.app',
  ])
  assert.equal(picked.updaterPath, '/b/macos/Uniopc.app.tar.gz')
  assert.equal(picked.installerPath, '/b/dmg/Uniopc_0.4.6_universal.dmg')
  assert.equal(picked.signaturePath, '/b/macos/Uniopc.app.tar.gz.sig')
})

test('pickPlatformArtifacts uses the NSIS setup exe as both updater and installer on Windows', () => {
  const picked = pickPlatformArtifacts('windows', [
    '/b/nsis/Uniopc_0.4.6_x64-setup.exe',
    '/b/msi/Uniopc_0.4.6_x64_en-US.msi',
  ])
  assert.equal(picked.updaterPath, '/b/nsis/Uniopc_0.4.6_x64-setup.exe')
  assert.equal(picked.installerPath, '/b/nsis/Uniopc_0.4.6_x64-setup.exe')
  assert.equal(picked.signaturePath, '/b/nsis/Uniopc_0.4.6_x64-setup.exe.sig')
})

test('pickPlatformArtifacts uses the AppImage as both updater and installer on Linux', () => {
  const picked = pickPlatformArtifacts('linux', [
    '/b/appimage/Uniopc_0.4.6_amd64.AppImage',
    '/b/deb/Uniopc_0.4.6_amd64.deb',
    '/b/rpm/Uniopc-0.4.6-1.x86_64.rpm',
  ])
  assert.equal(picked.updaterPath, '/b/appimage/Uniopc_0.4.6_amd64.AppImage')
  assert.equal(picked.installerPath, '/b/appimage/Uniopc_0.4.6_amd64.AppImage')
  assert.equal(picked.signaturePath, '/b/appimage/Uniopc_0.4.6_amd64.AppImage.sig')
})

test('installerAliasFileName matches the marketing-site latest links', () => {
  assert.equal(installerAliasFileName('darwin', 'aarch64'), 'Uniopc_aarch64.dmg')
  assert.equal(installerAliasFileName('darwin', 'x86_64'), 'Uniopc_x86_64.dmg')
  assert.equal(installerAliasFileName('windows', 'x86_64'), 'Uniopc_x86_64-setup.exe')
  assert.equal(installerAliasFileName('linux', 'x86_64'), 'Uniopc_x86_64.AppImage')
})

test('a single universal macOS bundle is published under both darwin archs', async () => {
  const fixture = await createDesktopFixture()
  const seen = []
  const deps = {
    uploadFileToStorage: async () => {},
    headUrl: async () => {},
    readLatestManifestVersion: async () => null,
    publishReleaseRow: async ({ row }) => {
      seen.push({ target: row.target, arch: row.arch, active: row.active, url: row.download_url })
    },
  }

  const results = await ciPublishDesktopArtifacts(
    {
      platform: 'darwin',
      archs: ['aarch64', 'x86_64'],
      artifactPaths: [fixture.updaterPath, fixture.installerPath],
      promote: true,
      env: releaseEnv(),
      ...fixture.configPaths,
    },
    deps,
  )

  assert.equal(results.length, 2)
  assert.deepEqual(seen.map((row) => row.arch), ['aarch64', 'x86_64'])
  assert.ok(seen.every((row) => row.target === 'darwin' && row.active === true))
  // Each arch gets its own version path, so both Mac types resolve an installer.
  assert.ok(seen[0].url.includes('/darwin/aarch64/'))
  assert.ok(seen[1].url.includes('/darwin/x86_64/'))
})

function releaseEnv() {
  return {
    SUPABASE_URL: 'https://abc.supabase.co',
    IMAI_RELEASE_PUBLISH_TOKEN: 'release-token',
    SUPABASE_RELEASE_BUCKET: 'desktop-releases',
    SUPABASE_STORAGE_API_KEY: 'storage-api-key',
  }
}

async function createDesktopFixture() {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-ci-publish-'))
  const desktopPackagePath = join(root, 'package.json')
  const cargoTomlPath = join(root, 'Cargo.toml')
  const tauriConfigPath = join(root, 'tauri.conf.json')
  const updaterPath = join(root, 'Uniopc.app.tar.gz')
  const signaturePath = `${updaterPath}.sig`
  const installerPath = join(root, 'Uniopc_0.4.6_universal.dmg')

  await writeFile(desktopPackagePath, JSON.stringify({ version: '0.4.6' }))
  await writeFile(cargoTomlPath, '[package]\nname = "uniopc"\nversion = "0.4.6"\n')
  await writeFile(
    tauriConfigPath,
    JSON.stringify({
      productName: 'Uniopc',
      version: '0.4.6',
      plugins: {
        updater: {
          pubkey: 'real-tauri-updater-public-key',
          endpoints: ['https://api.imai.app/storage/v1/object/public/desktop-releases/imai-desktop/stable/{{target}}/{{arch}}/latest.json'],
        },
      },
    }),
  )
  await writeFile(updaterPath, 'updater artifact')
  await writeFile(signaturePath, 'signature')
  await writeFile(installerPath, 'installer')

  return {
    updaterPath,
    installerPath,
    configPaths: { desktopPackagePath, cargoTomlPath, tauriConfigPath },
  }
}
