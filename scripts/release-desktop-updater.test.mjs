import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  buildLatestInstallerObjectKey,
  buildPublicStorageUrl,
  buildReleaseObjectKey,
  assertPromotionAdvancesVersion,
  parseReleaseArgs,
  publishReleaseRow,
  readLatestManifestVersion,
  releaseDesktopUpdater,
  validateInstallerVersion,
} from './release-desktop-updater.mjs'

test('buildReleaseObjectKey stores artifacts under immutable version paths', () => {
  assert.equal(
    buildReleaseObjectKey({
      product: 'imai-desktop',
      channel: 'stable',
      target: 'darwin',
      arch: 'aarch64',
      version: '0.0.2',
      fileName: 'Uniopc.app.tar.gz',
    }),
    'imai-desktop/stable/darwin/aarch64/0.0.2/Uniopc.app.tar.gz',
  )
})

test('promotion only accepts a strictly newer version', () => {
  assert.equal(assertPromotionAdvancesVersion({ candidateVersion: '0.0.3', publishedVersion: '0.0.2' }), true)
  assert.throws(() => assertPromotionAdvancesVersion({ candidateVersion: '0.0.2', publishedVersion: '0.0.2' }), /Promotion refused/)
  assert.throws(() => assertPromotionAdvancesVersion({ candidateVersion: '0.0.1', publishedVersion: '0.0.2' }), /Promotion refused/)
})

test('missing Supabase public manifest allows the first promotion on an architecture', async () => {
  const missing = async () => new Response(JSON.stringify({
    statusCode: '404',
    error: 'not_found',
    message: 'Object not found',
  }), { status: 400 })
  assert.equal(await readLatestManifestVersion('https://example.com/latest.json', missing), null)
  assert.equal(await readLatestManifestVersion('https://example.com/latest.json', async () => new Response(null, { status: 404 })), null)
})

test('other public manifest errors still stop promotion', async () => {
  await assert.rejects(
    readLatestManifestVersion('https://example.com/latest.json', async () => new Response(JSON.stringify({
      statusCode: '400',
      error: 'bad_request',
      message: 'Invalid bucket',
    }), { status: 400 })),
    /Cannot read current updater manifest \(400\)/,
  )
})

test('buildPublicStorageUrl encodes each object key segment', () => {
  assert.equal(
    buildPublicStorageUrl({
      supabaseUrl: 'https://abc.supabase.co',
      bucket: 'desktop-releases',
      key: 'imai-desktop/stable/darwin/aarch64/0.0.2/Uniopc Employee.app.tar.gz',
    }),
    'https://abc.supabase.co/storage/v1/object/public/desktop-releases/imai-desktop/stable/darwin/aarch64/0.0.2/Uniopc%20Employee.app.tar.gz',
  )
})

test('buildLatestInstallerObjectKey stores mutable website installers under stable latest paths', () => {
  assert.equal(
    buildLatestInstallerObjectKey({
      product: 'imai-desktop',
      channel: 'stable',
      target: 'darwin',
      arch: 'aarch64',
      fileName: 'Uniopc_aarch64.dmg',
    }),
    'imai-desktop/stable/darwin/aarch64/latest/Uniopc_aarch64.dmg',
  )
})

test('parseReleaseArgs defaults to Supabase publish environment', () => {
  const args = parseReleaseArgs([])

  assert.ok(args.envFile.endsWith('.env.release'))
})

test('releaseDesktopUpdater refuses the retired Supabase project before uploading', async () => {
  await assert.rejects(() => releaseDesktopUpdater({
    env: {
      SUPABASE_URL: 'https://spb-bp10i1915oj07495.supabase.opentrust.net',
      IMAI_RELEASE_PUBLISH_TOKEN: 'test-token',
      SUPABASE_RELEASE_BUCKET: 'desktop-releases',
      SUPABASE_STORAGE_API_KEY: 'test-key',
    },
  }), /legacy Supabase project is retired/)
})

test('releaseDesktopUpdater uploads artifacts and upserts disabled metadata by default', async () => {
  const fixture = await createReleaseFixture()
  const calls = []

  const result = await releaseDesktopUpdater(
    {
      app: 'admin',
      target: 'darwin',
      arch: 'aarch64',
      artifactPath: fixture.artifactPath,
      signaturePath: fixture.signaturePath,
      installerPath: fixture.installerPath,
      notes: 'Release notes',
      publishedAt: '2026-05-19T12:00:00.000Z',
      desktopPackagePath: fixture.desktopPackagePath,
      cargoTomlPath: fixture.cargoTomlPath,
      tauriConfigPath: fixture.tauriConfigPath,
      env: releaseEnv(),
    },
    fakeDeps(calls),
  )

  assert.equal(result.row.version, '0.0.2')
  assert.equal(result.row.active, false)
  assert.equal(result.row.download_url, 'https://abc.supabase.co/storage/v1/object/public/desktop-releases/imai-desktop/stable/darwin/aarch64/0.0.2/Uniopc.app.tar.gz')
  assert.deepEqual(
    calls.map((call) => call.type),
    ['storage-upload', 'storage-upload', 'storage-upload', 'head', 'head', 'head', 'publish'],
  )
  assert.deepEqual(
    calls.filter((call) => call.type === 'storage-upload').map((call) => call.key),
    [
      'imai-desktop/stable/darwin/aarch64/0.0.2/Uniopc.app.tar.gz',
      'imai-desktop/stable/darwin/aarch64/0.0.2/Uniopc.app.tar.gz.sig',
      'imai-desktop/stable/darwin/aarch64/0.0.2/Uniopc_0.0.2_aarch64.dmg',
    ],
  )
  assert.equal(
    calls.find((call) => call.type === 'storage-upload' && call.key.endsWith('.sig'))?.contentType,
    'text/plain',
  )
  assert.equal(result.installerAliasKey, 'imai-desktop/stable/darwin/aarch64/latest/Uniopc_aarch64.dmg')
  assert.equal(result.installerUrl, 'https://abc.supabase.co/storage/v1/object/public/desktop-releases/imai-desktop/stable/darwin/aarch64/0.0.2/Uniopc_0.0.2_aarch64.dmg')
  assert.equal(result.installerAliasUrl, 'https://abc.supabase.co/storage/v1/object/public/desktop-releases/imai-desktop/stable/darwin/aarch64/latest/Uniopc_aarch64.dmg')
})

test('releaseDesktopUpdater writes no public updater manifest for staged (unpromoted) releases', async () => {
  const fixture = await createReleaseFixture()
  const calls = []

  const result = await releaseDesktopUpdater(
    {
      app: 'admin',
      target: 'darwin',
      arch: 'aarch64',
      artifactPath: fixture.artifactPath,
      signaturePath: fixture.signaturePath,
      desktopPackagePath: fixture.desktopPackagePath,
      cargoTomlPath: fixture.cargoTomlPath,
      tauriConfigPath: fixture.tauriConfigPath,
      env: releaseEnv(),
    },
    fakeDeps(calls),
  )

  assert.equal(result.manifestKey, null)
  assert.equal(result.manifestUrl, null)
  assert.equal(
    calls.some((call) => call.type === 'storage-upload' && call.key.endsWith('/latest.json')),
    false,
  )
})

test('releaseDesktopUpdater publishes a public auth-free updater manifest when promoted', async () => {
  const fixture = await createReleaseFixture()
  const calls = []

  const result = await releaseDesktopUpdater(
    {
      app: 'admin',
      target: 'darwin',
      arch: 'aarch64',
      artifactPath: fixture.artifactPath,
      signaturePath: fixture.signaturePath,
      promote: true,
      publishedAt: '2026-05-19T12:00:00.000Z',
      notes: 'Release notes',
      desktopPackagePath: fixture.desktopPackagePath,
      cargoTomlPath: fixture.cargoTomlPath,
      tauriConfigPath: fixture.tauriConfigPath,
      env: releaseEnv(),
    },
    fakeDeps(calls),
  )

  assert.equal(result.manifestKey, 'imai-desktop/stable/darwin/aarch64/latest.json')
  assert.equal(
    result.manifestUrl,
    'https://abc.supabase.co/storage/v1/object/public/desktop-releases/imai-desktop/stable/darwin/aarch64/latest.json',
  )
  const manifestUpload = calls.find(
    (call) => call.type === 'storage-upload' && call.key === 'imai-desktop/stable/darwin/aarch64/latest.json',
  )
  assert.ok(manifestUpload, 'manifest upload should be present')
  assert.equal(manifestUpload.contentType, 'application/json')
  const manifest = JSON.parse(manifestUpload.content)
  assert.equal(manifest.version, '0.0.2')
  assert.equal(manifest.pub_date, '2026-05-19T12:00:00.000Z')
  assert.equal(
    manifest.url,
    'https://abc.supabase.co/storage/v1/object/public/desktop-releases/imai-desktop/stable/darwin/aarch64/0.0.2/Uniopc.app.tar.gz',
  )
  assert.ok(manifest.signature, 'manifest should carry the artifact signature')
  // The manifest URL is HEAD-checked for public reachability like every other upload.
  assert.ok(calls.some((call) => call.type === 'head' && call.url === result.manifestUrl))
})

test('releaseDesktopUpdater enables metadata only when promote is true', async () => {
  const fixture = await createReleaseFixture()
  const calls = []

  const result = await releaseDesktopUpdater(
    {
      app: 'admin',
      target: 'darwin',
      arch: 'aarch64',
      artifactPath: fixture.artifactPath,
      signaturePath: fixture.signaturePath,
      promote: true,
      desktopPackagePath: fixture.desktopPackagePath,
      cargoTomlPath: fixture.cargoTomlPath,
      tauriConfigPath: fixture.tauriConfigPath,
      env: releaseEnv(),
    },
    fakeDeps(calls),
  )

  assert.equal(result.row.active, true)
  assert.equal(calls.find((call) => call.type === 'publish').row.active, true)
})

test('releaseDesktopUpdater refuses promotion before uploading when the public manifest is newer', async () => {
  const fixture = await createReleaseFixture()
  const calls = []
  const deps = {
    ...fakeDeps(calls),
    readLatestManifestVersion: async () => '0.0.3',
  }

  await assert.rejects(
    releaseDesktopUpdater(
      {
        app: 'admin',
        target: 'darwin',
        arch: 'aarch64',
        artifactPath: fixture.artifactPath,
        signaturePath: fixture.signaturePath,
        promote: true,
        desktopPackagePath: fixture.desktopPackagePath,
        cargoTomlPath: fixture.cargoTomlPath,
        tauriConfigPath: fixture.tauriConfigPath,
        env: releaseEnv(),
      },
      deps,
    ),
    /Promotion refused/,
  )
  assert.equal(calls.length, 0)
})

test('inactive staging cannot overwrite or deactivate an already live version', async () => {
  const fixture = await createReleaseFixture()
  for (const publishedVersion of ['0.0.2', '0.0.3']) {
    const calls = []
    await assert.rejects(releaseDesktopUpdater({
      target: 'darwin', arch: 'aarch64',
      artifactPath: fixture.artifactPath, signaturePath: fixture.signaturePath,
      desktopPackagePath: fixture.desktopPackagePath,
      cargoTomlPath: fixture.cargoTomlPath, tauriConfigPath: fixture.tauriConfigPath,
      env: releaseEnv(),
    }, { ...fakeDeps(calls), readLatestManifestVersion: async () => publishedVersion }), /not newer/)
    assert.deepEqual(calls, [], 'must fail before any upload or release-row write')
  }
})

test('releaseDesktopUpdater publishes through fixed release token instead of service role key', async () => {
  const fixture = await createReleaseFixture()
  const calls = []

  await releaseDesktopUpdater(
    {
      app: 'admin',
      target: 'darwin',
      arch: 'aarch64',
      artifactPath: fixture.artifactPath,
      signaturePath: fixture.signaturePath,
      desktopPackagePath: fixture.desktopPackagePath,
      cargoTomlPath: fixture.cargoTomlPath,
      tauriConfigPath: fixture.tauriConfigPath,
      env: {
        ...releaseEnv(),
        IMAI_RELEASE_PUBLISH_TOKEN: 'release-token',
      },
    },
    fakeDeps(calls),
  )

  assert.equal(calls.at(-1).type, 'publish')
  assert.equal(calls.at(-1).releaseToken, 'release-token')
})

test('releaseDesktopUpdater requires a Storage REST API key', async () => {
  const fixture = await createReleaseFixture()

  await assert.rejects(
    releaseDesktopUpdater(
      {
        app: 'admin',
        target: 'darwin',
        arch: 'aarch64',
        artifactPath: fixture.artifactPath,
        signaturePath: fixture.signaturePath,
        desktopPackagePath: fixture.desktopPackagePath,
        cargoTomlPath: fixture.cargoTomlPath,
        tauriConfigPath: fixture.tauriConfigPath,
        env: {
          SUPABASE_URL: 'https://abc.supabase.opentrust.net',
          IMAI_RELEASE_PUBLISH_TOKEN: 'release-token',
          SUPABASE_RELEASE_BUCKET: 'desktop-releases',
        },
      },
      fakeDeps([]),
    ),
    /SUPABASE_STORAGE_API_KEY or SUPABASE_API_KEY or SUPABASE_SERVICE_ROLE_KEY/,
  )
})

test('releaseDesktopUpdater rejects installer files from another version', async () => {
  const fixture = await createReleaseFixture({ installerName: 'Uniopc_0.0.1_aarch64.dmg' })

  await assert.rejects(
    releaseDesktopUpdater(
      {
        app: 'admin',
        target: 'darwin',
        arch: 'aarch64',
        artifactPath: fixture.artifactPath,
        signaturePath: fixture.signaturePath,
        installerPath: fixture.installerPath,
        desktopPackagePath: fixture.desktopPackagePath,
        cargoTomlPath: fixture.cargoTomlPath,
        tauriConfigPath: fixture.tauriConfigPath,
        env: releaseEnv(),
      },
      fakeDeps([]),
    ),
    /Installer file name does not match release version 0\.0\.2/,
  )
})

test('validateInstallerVersion allows versionless aliases only when caller skips the release check', () => {
  assert.equal(validateInstallerVersion({ installerPath: '/tmp/Uniopc_0.0.2_aarch64.dmg', version: '0.0.2' }), true)
  assert.throws(
    () => validateInstallerVersion({ installerPath: '/tmp/Uniopc_aarch64.dmg', version: '0.0.2' }),
    /Installer file name does not match release version/,
  )
})

test('publishReleaseRow calls publish-desktop-release with release token header', async () => {
  const requests = []
  await publishReleaseRow(
    {
      supabaseUrl: 'https://abc.supabase.co',
      releaseToken: 'release-token',
      row: {
        product: 'imai-desktop',
        target: 'darwin',
        arch: 'aarch64',
        version: '0.0.2',
        channel: 'stable',
        download_url: 'https://abc.supabase.co/storage/v1/object/public/desktop-releases/file.tar.gz',
        signature: 'sig',
        notes: '',
        published_at: '2026-05-19T12:00:00.000Z',
        active: false,
      },
    },
    async (url, init) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
  )

  assert.equal(requests[0].url, 'https://abc.supabase.co/functions/v1/publish-desktop-release')
  assert.equal(requests[0].init.headers['x-release-token'], 'release-token')
  assert.equal(JSON.parse(requests[0].init.body).version, '0.0.2')
})

function fakeDeps(calls) {
  return {
    uploadFileToStorage: async (upload) => {
      calls.push({ type: 'storage-upload', key: upload.key, filePath: upload.filePath, content: upload.content, contentType: upload.contentType })
    },
    headUrl: async (url) => {
      calls.push({ type: 'head', url })
    },
    publishReleaseRow: async ({ row, releaseToken }) => {
      calls.push({ type: 'publish', row, releaseToken })
    },
    readLatestManifestVersion: async () => null,
  }
}

function releaseEnv() {
  return {
    SUPABASE_URL: 'https://abc.supabase.co',
    IMAI_RELEASE_PUBLISH_TOKEN: 'release-token',
    SUPABASE_RELEASE_BUCKET: 'desktop-releases',
    SUPABASE_STORAGE_API_KEY: 'storage-api-key',
  }
}

async function createReleaseFixture({ installerName = 'Uniopc_0.0.2_aarch64.dmg' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'imai-one-click-release-'))
  const desktopPackagePath = join(root, 'package.json')
  const cargoTomlPath = join(root, 'Cargo.toml')
  const tauriConfigPath = join(root, 'tauri.conf.json')
  const artifactPath = join(root, 'Uniopc.app.tar.gz')
  const signaturePath = join(root, 'Uniopc.app.tar.gz.sig')
  const installerPath = join(root, installerName)

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
  await writeFile(artifactPath, 'artifact')
  await writeFile(signaturePath, 'signature')
  await writeFile(installerPath, 'installer')

  return {
    desktopPackagePath,
    cargoTomlPath,
    tauriConfigPath,
    artifactPath,
    signaturePath,
    installerPath,
  }
}
