import { inspectLifecycleCoordinatorSources } from './verify-uniopc-whitelabel-runtime.mjs'
import { isManagedSkillMarkdown, rebrandSkillMarkdown } from './uniopc-skill-branding.mjs'
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

const DISPLAY_KEYS = new Set([
  'blurb', 'description', 'detailLabel', 'displayName', 'label', 'productName',
  'selectionLabel', 'shortDescription', 'short_name', 'title',
  'browserHelpText', 'secretsHelpText', 'nodesHelpText', 'rootHelpText',
])
const BRAND = /(?<![A-Za-z0-9_])(?:OpenClaw|小龙虾)(?![A-Za-z0-9_])/gi

export function rebrandVisibleText(value) {
  return value.replace(BRAND, 'Uniopc')
}

function rebrandCliHelpText(value) {
  // Preserve upstream documentation URLs and technical command/config names.
  return value.replaceAll('Usage: openclaw', 'Usage: uniopc-engine')
    .replace(/OpenClaw|小龙虾/g, 'Uniopc')
}

// The engine reads these files when it creates a fresh workspace. Keep this
// small runtime input while removing the rest of upstream's documentation.
export async function retainRuntimeWorkspaceTemplates(packageRoot) {
  const docs = join(packageRoot, 'docs')
  const reference = join(docs, 'reference')
  const templates = join(reference, 'templates')
  for (const required of ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md']) {
    await readFile(join(templates, required), 'utf8').catch(() => {
      throw new Error(`Runtime workspace template missing: ${required} in ${templates}`)
    })
  }
  for (const [directory, keep] of [[docs, 'reference'], [reference, 'templates']]) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name !== keep) await rm(join(directory, entry.name), { recursive: true, force: true })
    }
  }
  for (const entry of await readdir(templates, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const path = join(templates, entry.name)
    const original = await readFile(path, 'utf8')
    const branded = rebrandVisibleText(original)
    if (branded !== original) await writeFile(path, branded, 'utf8')
  }
}

export function rebrandDisplayMetadata(value, { browserManifest = false, cliHelp = false, key = '' } = {}) {
  if (typeof value === 'string') {
    if (cliHelp || /^(?:browser|secrets|nodes|root)HelpText$/.test(key)) return rebrandCliHelpText(value)
    if (DISPLAY_KEYS.has(key) || (browserManifest && key === 'name')) return rebrandVisibleText(value)
    return value
  }
  if (Array.isArray(value)) return value.map(item => rebrandDisplayMetadata(item, { browserManifest, cliHelp, key }))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    rebrandDisplayMetadata(child, { browserManifest, cliHelp: cliHelp || childKey === 'subcommandHelpText', key: childKey }),
  ]))
}

async function walk(directory, callback) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, callback)
    else if (entry.isFile()) await callback(path)
  }
}

export async function rebrandRuntimeTree(packageRoot) {
  const changed = []
  await walk(packageRoot, async path => {
    if (isManagedSkillMarkdown(relative(packageRoot, path))) {
      const before = await readFile(path, 'utf8')
      const after = rebrandSkillMarkdown(before)
      if (after !== before) {
        await writeFile(path, after, 'utf8')
        changed.push(path)
      }
      return
    }
    if (/\.html$/i.test(path)) {
      const before = await readFile(path, 'utf8')
      const after = rebrandVisibleText(before)
      if (after !== before) {
        await writeFile(path, after, 'utf8')
        changed.push(path)
      }
      return
    }
    if (!/\.json$/i.test(path)) return
    const before = await readFile(path, 'utf8').catch(() => null)
    if (before === null) return
    let parsed
    try { parsed = JSON.parse(before) } catch { return }
    const browserManifest = /dist\/extensions\/browser\/chrome-extension\/manifest\.json$/i.test(path)
    const transformed = rebrandDisplayMetadata(parsed, { browserManifest })
    if (JSON.stringify(transformed) === JSON.stringify(parsed)) return
    const after = `${JSON.stringify(transformed, null, 2)}\n`
    if (after !== before) {
      await writeFile(path, after, 'utf8')
      changed.push(path)
    }
  })
  return changed
}

// Compiled chunk references are independent of the plugin-manifest contract below.
// Managed package scopes are transformed separately by uniopc-runtime-scopes.mjs.
export async function rebrandCompiledRuntimePaths(packageRoot) {
  const dist = join(packageRoot, 'dist')
  const files = []
  await walk(dist, path => { files.push(path) })
  const changes = new Map()
  for (const path of files) {
    const rel = relative(dist, path).replaceAll('\\', '/')
    const basename = rel.split('/').at(-1)
    if (!/openclaw/i.test(basename) || !/\.(?:js|mjs|cjs|d\.ts|d\.mts|png)$/i.test(basename)) continue
    if (/openclaw\.plugin\./i.test(basename)) continue
    const branded = basename.replace(/openclaw/gi, 'uniopc')
    if (files.includes(join(path, '..', branded))) throw new Error(`Runtime chunk rename collision: ${rel}`)
    changes.set(path, { rel, basename, branded })
  }
  const textFiles = files.filter(path => /\.(?:js|mjs|cjs|ts|mts|json|html|css|map)$/i.test(path))
  // Preflight every role before writing or renaming any staged file.
  const sources = await Promise.all(textFiles.map(async path => ({path, source: await readFile(path, 'utf8')})))
  const lifecycle = inspectLifecycleCoordinatorSources(sources.filter(entry => /\.[cm]?js$/i.test(entry.path)), {allowUnpatched: true})
  const lifecycleByPath = new Map(lifecycle.map(entry => [entry.path, entry]))
  const patches = []
  let lockPathMatches = 0
  for (const {path, source: before} of sources) {
    const coordinator = lifecycleByPath.get(path)
    let after = coordinator ? before.slice(0, coordinator.start) + coordinator.patchedBody + before.slice(coordinator.start + coordinator.body.length) : before
    for (const { basename, branded } of changes.values()) after = after.replaceAll(basename, branded)
    if (/\/paths-[^/]+\.js$/i.test(path.replaceAll('\\', '/'))) {
      const legacy = '`openclaw-${uid}` : "openclaw"'
      const branded = '`uniopc-${uid}` : "uniopc"'
      if (after.includes(legacy)) {
        after = after.replace(legacy, branded)
        lockPathMatches++
      } else if (after.includes(branded)) {
        lockPathMatches++
      }
    }
    if (after !== before) patches.push([path, after])
  }
  if (lockPathMatches !== 1) throw new Error(`Expected one gateway lock directory definition, found ${lockPathMatches}`)
  for (const [path, after] of patches) await writeFile(path, after)
  for (const [path, { branded }] of changes) await rename(path, join(path, '..', branded))
  return [...changes.values()].map(({ rel }) => rel)
}


const LEGACY_PLUGIN_MANIFEST = 'openclaw.plugin.json'
const PLUGIN_MANIFEST = 'uniopc.plugin.json'
const MANIFEST_COMPAT_HELPER = `import { existsSync as uniopcManifestExists } from "node:fs";
function uniopcManifestReadPath(file) {
  if (uniopcManifestExists(file)) return file;
  const legacy = file.slice(0, -"uniopc.plugin.json".length) + "openclaw.plugin.json";
  return uniopcManifestExists(legacy) ? legacy : file;
}
`

// Patch only our staged upstream dist. Existing user plugins can still be read
// under their old name; generated files and our shipped resources use Uniopc.
export async function rebrandPluginManifestPaths(packageRoot) {
  const files = []
  await walk(packageRoot, path => { files.push(path) })
  const manifests = files.filter(path => basename(path) === LEGACY_PLUGIN_MANIFEST)
  for (const path of manifests) {
    if (files.includes(join(path, '..', PLUGIN_MANIFEST))) throw new Error(`Plugin manifest rename collision: ${path}`)
  }
  const patches = []
  let loaderCount = 0
  for (const path of files.filter(path => /\/dist\/.*\.(?:js|mjs|cjs|json|ts|mts|map)$/.test(path.replaceAll('\\', '/')))) {
    const before = await readFile(path, 'utf8')
    // Normalize prior transforms before applying the current contract. This
    // also upgrades already branded archives instead of trusting an old marker.
    let after = before.startsWith(MANIFEST_COMPAT_HELPER) ? before.slice(MANIFEST_COMPAT_HELPER.length) : before
    after = after.replace(/uniopcManifestReadPath\((path\.join\([^()\n]*\))\)/g, '$1')
    after = after.replaceAll(LEGACY_PLUGIN_MANIFEST, PLUGIN_MANIFEST)
    if (!/\.(?:js|mjs|cjs)$/.test(path)) {
      if (after !== before) patches.push([path, after])
      continue
    }
    // All fixed-name reader call sites in the pinned engine are path.join calls
    // with simple identifier/property arguments. Refuse silent coverage drift.
    let compat = false
    after = after.replace(/path\.join\(([^()\n]*?), (?:"uniopc\.plugin\.json"|PLUGIN_MANIFEST_FILENAME)\)/g, (match) => {
      compat = true
      return `uniopcManifestReadPath(${match})`
    })
    if (/plugins-authoring-command-/.test(path)) {
      const outputPath = 'const manifestPath = uniopcManifestReadPath(path.join(rootDir, PLUGIN_MANIFEST_FILENAME));'
      if (!after.includes(outputPath)) throw new Error(`Plugin authoring output path drift: ${path}`)
      after = after.replace(outputPath, 'const manifestPath = path.join(rootDir, PLUGIN_MANIFEST_FILENAME);')
      const oldRead = 'const currentManifest = fs.existsSync(manifestPath) ? readJsonFile(manifestPath) : void 0;'
      const newRead = 'const currentManifestPath = uniopcManifestReadPath(manifestPath);\n\tconst currentManifest = fs.existsSync(currentManifestPath) ? readJsonFile(currentManifestPath) : void 0;'
      if (after.includes(oldRead)) after = after.replace(oldRead, newRead)
      else if (!after.includes(newRead)) throw new Error(`Plugin authoring input path drift: ${path}`)
      const scaffoldWrite = 'writeJsonFile(uniopcManifestReadPath(path.join(params.rootDir, PLUGIN_MANIFEST_FILENAME)),'
      if (after.split(scaffoldWrite).length - 1 !== 2) throw new Error(`Plugin scaffold output path drift: ${path}`)
      after = after.replaceAll(scaffoldWrite, 'writeJsonFile(path.join(params.rootDir, PLUGIN_MANIFEST_FILENAME),')
      if (!after.includes('readJsonFile(uniopcManifestReadPath(path.join(rootDir, PLUGIN_MANIFEST_FILENAME)))')) {
        throw new Error(`Plugin validation input path drift: ${path}`)
      }
    }
    if (after.includes('function loadPluginManifest(rootDir, rejectHardlinks = true, rootRealPath) {')) {
      const anchor = 'relativePath: PLUGIN_MANIFEST_FILENAME,'
      if (!after.includes(anchor) && !after.includes('relativePath: path.basename(manifestPath),')) throw new Error(`Plugin manifest loader drift: ${path}`)
      after = after.replace(anchor, 'relativePath: path.basename(manifestPath),')
      loaderCount++
    }
    // This facade is bundled-only, so it deliberately has no legacy fallback.
    after = (compat ? MANIFEST_COMPAT_HELPER : '') + after
    if (after !== before) patches.push([path, after])
  }
  if (loaderCount !== 1) {
    throw new Error(`Expected one plugin manifest loader definition, found ${loaderCount}`)
  }
  for (const [path, source] of patches) await writeFile(path, source)
  for (const path of manifests) await rename(path, join(path, '..', PLUGIN_MANIFEST))
  return { renamed: manifests.length, patched: patches.length }
}


export async function rebrandEngineWrapperContract(packageRoot) {
  const entry = join(packageRoot, 'dist', 'entry.js')
  const source = await readFile(entry, 'utf8')
  const legacy = 'wrapperBasename: "openclaw.mjs"'
  const branded = 'wrapperBasename: "uniopc-engine.mjs"'
  const count = source.split(legacy).length - 1 + source.split(branded).length - 1
  if (count < 2) throw new Error(`Engine entry wrapper contract changed: expected at least two wrapper entries in ${entry}`)
  await writeFile(entry, source.replaceAll(legacy, branded), 'utf8')
}
