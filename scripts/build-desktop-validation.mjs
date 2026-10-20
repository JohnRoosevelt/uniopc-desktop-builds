#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  clearStaleRuntimeResourceOutput, releaseSpawnTarget,
  runtimeTargetFromTauriTarget, stageRuntimeResourceSnapshot,
} from './build-desktop-release.mjs'
import { readDesktopReleaseVersion } from './prepare-desktop-updater-release.mjs'
import { selectRuntimeArtifact, verifyReleaseContract } from './verify-openclaw-release-contract.mjs'
import { prepareBundledPluginDependencies } from './prepare-bundled-plugin-dependencies.mjs'

export function validationEnvironment(source, platform) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith('APPLE_') && !key.startsWith('TAURI_SIGNING_')
    && !key.startsWith('UNIOPC_PLUGIN_AUDIT_')
    && !['IMAI_RELEASE_PUBLISH_TOKEN', 'SUPABASE_STORAGE_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
      'UNIOPC_RUNTIME_ALLOW_UNSIGNED_LOCAL', 'UNIOPC_SKIP_RUNTIME_CODESIGN'].includes(key)))
  // Ad-hoc signing permits local execution on Apple Silicon without a
  // Developer ID certificate. It is not release signing or notarization.
  if (platform === 'darwin') env.APPLE_CODESIGN_IDENTITY = '-'
  return env
}

export function validationConfig(snapshotConfig, platform) {
  return {
    ...snapshotConfig,
    productName: 'Uniopc Validation',
    identifier: 'com.imai.validation',
    bundle: {
      ...snapshotConfig.bundle,
      targets: [platform === 'darwin' ? 'dmg' : platform === 'win32' ? 'nsis' : 'appimage'],
      createUpdaterArtifacts: false,
      ...(platform === 'darwin' ? { macOS: { signingIdentity: '-' } } : {}),
    },
  }
}

export function parseValidationArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--target') {
    throw new Error('Usage: npm run build:validation -- --target <native-target>; publication is not supported.')
  }
  runtimeTargetFromTauriTarget(argv[1])
  return { target: argv[1] }
}

async function runNpm(args, env) {
  const target = releaseSpawnTarget('npm', args, { npmExecPath: env.npm_execpath })
  await new Promise((resolveExit, reject) => {
    const child = spawn(target.command, target.args, { env, stdio: 'inherit', cwd: process.cwd() })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolveExit() : reject(new Error('Validation command failed: ' + code)))
  })
}

export async function buildDesktopValidation({ target }, deps = {}) {
  const runtime = runtimeTargetFromTauriTarget(target)
  const env = validationEnvironment(deps.env || process.env, runtime.platform)
  const version = await (deps.readVersion || readDesktopReleaseVersion)()
  const run = deps.run || runNpm
  await (deps.prepareBundledPlugins || prepareBundledPluginDependencies)()
  await run(['run', 'build:openclaw-runtime', '--', '--force', '--platform', runtime.platform, '--arch', runtime.arch], env)
  await (deps.verifyRuntime || verifyReleaseContract)(runtime)
  const bundle = deps.readRuntime ? await deps.readRuntime(runtime) : await readRuntimeBundle(runtime)
  const snapshot = await (deps.snapshotRuntime || stageRuntimeResourceSnapshot)(bundle, env)
  try {
    if (!await snapshot.verify()) throw new Error('Validation runtime snapshot integrity check failed.')
    const source = JSON.parse(await readFile(snapshot.tauriConfigPath, 'utf8'))
    const configPath = join(snapshot.root, 'tauri-validation.json')
    await writeFile(configPath, JSON.stringify(validationConfig(source, runtime.platform)), { flag: 'wx', mode: 0o400 })
    await (deps.clearRuntime || clearStaleRuntimeResourceOutput)(target)
    if (!await snapshot.verify()) throw new Error('Validation runtime snapshot integrity check failed.')
    await run(['run', 'tauri', '--', 'build', '--target', target, '--config', configPath], env)
    const record = {
      validationOnly: true, desktopVersion: version, runtimeVersion: bundle.manifest.version,
      target, updaterArtifacts: false, releaseSigningVerified: false, notarized: false, published: false,
    }
    const output = resolve('dist', 'release-artifacts')
    if (deps.writeRecord) await deps.writeRecord(record)
    else {
      await mkdir(output, { recursive: true })
      await writeFile(join(output, 'build-validation.json'), JSON.stringify(record, null, 2) + '\n')
    }
    return record
  } finally {
    await snapshot.cleanup()
  }
}

async function readRuntimeBundle(runtime) {
  const root = resolve('src-tauri', 'resources', 'uniopc-engine-runtime')
  const catalog = JSON.parse(await readFile(join(root, 'uniopc-engine-runtime.catalog.json'), 'utf8'))
  const manifest = selectRuntimeArtifact(catalog, runtime)
  return { archivePath: join(root, manifest.archive), manifest }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildDesktopValidation(parseValidationArgs(process.argv.slice(2))).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
