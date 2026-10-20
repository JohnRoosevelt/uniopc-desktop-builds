#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { rebrandManagedRuntimeScopes } from './uniopc-runtime-scopes.mjs'
import { rebrandEngineWrapperContract, rebrandPluginManifestPaths, rebrandCompiledRuntimePaths, rebrandRuntimeTree, retainRuntimeWorkspaceTemplates } from './uniopc-runtime-branding.mjs'
import { verifyRuntimeDirectory } from './verify-uniopc-whitelabel-runtime.mjs'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_RUNTIME_DIR = join(PROJECT_ROOT, 'src-tauri', 'resources', 'uniopc-engine-runtime')
const CATALOG = 'uniopc-engine-runtime.catalog.json'

function tarBin() {
  if (process.platform !== 'win32') return 'tar'
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return join(root, 'System32', 'tar.exe')
}

export async function rebrandRuntimeArchives(runtimeDirectory = DEFAULT_RUNTIME_DIR) {
  const catalogPath = join(runtimeDirectory, CATALOG)
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  const work = await mkdtemp(join(tmpdir(), 'uniopc-rebrand-runtime-'))
  const pending = []
  try {
    for (const artifact of catalog.artifacts) {
      const archive = join(runtimeDirectory, artifact.archive)
      const stage = join(work, `${artifact.platform}-${artifact.arch}`)
      await mkdir(stage, { recursive: true })
      execFileSync(tarBin(), ['-xzf', archive, '-C', stage], { stdio: 'ignore' })
      const nodeRoot = artifact.platform === 'win32'
        ? join(stage, 'tools', 'node')
        : join(stage, 'tools', `node-v${artifact.nodeVersion}`)
      const packageRoot = artifact.platform === 'win32'
        ? join(nodeRoot, 'node_modules', 'uniopc-engine')
        : join(nodeRoot, 'lib', 'node_modules', 'uniopc-engine')
      const legacyPackageRoot = artifact.platform === 'win32'
        ? join(nodeRoot, 'node_modules', 'openclaw')
        : join(nodeRoot, 'lib', 'node_modules', 'openclaw')
      if (await readFile(join(legacyPackageRoot, 'package.json'), 'utf8').then(() => true, () => false)) {
        await rename(legacyPackageRoot, packageRoot)
      }
      await retainRuntimeWorkspaceTemplates(packageRoot)
      await rebrandEngineWrapperContract(packageRoot)
      const manifestPath = join(packageRoot, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const oldEntry = join(packageRoot, 'openclaw.mjs')
      const brandedEntry = join(packageRoot, 'uniopc-engine.mjs')
      if (await readFile(oldEntry, 'utf8').then(() => true, () => false)) {
        await rename(oldEntry, brandedEntry)
      } else if (!(await readFile(brandedEntry, 'utf8').then(() => true, () => false))) {
        throw new Error(`Runtime package has no CLI entry at ${brandedEntry}`)
      }
      if (manifest.bin) manifest.bin = Object.fromEntries(Object.entries(manifest.bin).map(([name, entry]) => [
        name === 'openclaw' ? 'uniopc-engine' : name,
        entry === 'openclaw.mjs' ? 'uniopc-engine.mjs' : entry,
      ]))
      if (manifest.exports?.['./cli-entry'] === './openclaw.mjs') manifest.exports['./cli-entry'] = './uniopc-engine.mjs'
      if (manifest.scripts?.start === 'node openclaw.mjs') manifest.scripts.start = 'node uniopc-engine.mjs'
      if (manifest.directories?.doc === 'docs') delete manifest.directories.doc
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      const launcherPaths = [join(stage, 'bin', 'uniopc-engine'), join(nodeRoot, 'uniopc-engine.cmd')]
      for (const launcher of launcherPaths) {
        const source = await readFile(launcher, 'utf8').catch(() => null)
        if (source === null) continue
        const branded = source
          .replaceAll('/node_modules/openclaw/', '/node_modules/uniopc-engine/')
          .replaceAll('\\node_modules\\openclaw\\openclaw.mjs', '\\node_modules\\uniopc-engine\\uniopc-engine.mjs')
        if (branded !== source) await writeFile(launcher, branded, 'utf8')
      }
      const changed = await rebrandRuntimeTree(packageRoot)
      const pluginManifests = await rebrandPluginManifestPaths(packageRoot)
      const scopes = await rebrandManagedRuntimeScopes(packageRoot)
      const renamed = await rebrandCompiledRuntimePaths(packageRoot)
      const nextArchive = join(work, artifact.archive)
      execFileSync(tarBin(), ['-czf', nextArchive, '-C', stage, 'bin', 'tools'], { stdio: 'ignore' })
      const bytes = await readFile(nextArchive)
      artifact.sha256 = createHash('sha256').update(bytes).digest('hex')
      artifact.sizeBytes = bytes.length
      pending.push({ archive, nextArchive, changedCount: changed.length + renamed.length + pluginManifests.renamed + pluginManifests.patched + scopes.renamed + scopes.patched })
    }

    const validation = join(work, 'validation')
    await mkdir(validation, { recursive: true })
    for (const item of pending) await copyFile(item.nextArchive, join(validation, item.archive.split(/[\\/]/).at(-1)))
    await writeFile(join(validation, CATALOG), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
    const report = await verifyRuntimeDirectory(validation)

    const oldCatalog = join(work, 'old-catalog.json')
    await rename(catalogPath, oldCatalog)
    try {
      for (const [index, item] of pending.entries()) {
        item.oldArchive = join(work, `old-${index}.tar.gz`)
        await rename(item.archive, item.oldArchive)
        await rename(item.nextArchive, item.archive)
      }
      await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
    } catch (error) {
      for (const item of pending) {
        if (item.oldArchive) await rename(item.oldArchive, item.archive).catch(() => {})
      }
      await rename(oldCatalog, catalogPath).catch(() => {})
      throw error
    }
    return { ...report, changedFiles: pending.reduce((sum, item) => sum + item.changedCount, 0) }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_RUNTIME_DIR
  rebrandRuntimeArchives(target)
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1 })
}
