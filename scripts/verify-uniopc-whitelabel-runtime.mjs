#!/usr/bin/env node

import { isManagedSkillMarkdown, skillBrandOccurrences } from './uniopc-skill-branding.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RUNTIME_DIR = join(PROJECT_ROOT, 'src-tauri', 'resources', 'uniopc-engine-runtime')
const CATALOG = 'uniopc-engine-runtime.catalog.json'
const BRANDED_ENGINE_ROOT = /^tools\/node(?:-v[^/]+)?\/(?:lib\/)?node_modules\/uniopc-engine(?:\/|$)/i
const LEGAL_ATTRIBUTION_LINES = [
  'Copyright (c) 2026 OpenClaw Foundation',
  'portions incorporated into OpenClaw source, beyond normal package-manager',
  'Portions of OpenClaw were adapted from Pi / pi-mono, and OpenClaw also depends',
  'OPENCLAW_ATTRIBUTION_PRODUCT = "OpenClaw"',
  '"MM-API-Source": "OpenClaw"',
  '"MM-API-Source":"OpenClaw"',
  '"X-OpenRouter-Title": "OpenClaw"',
  '"X-OpenRouter-Title":"OpenClaw"',
]
// Pinned 2026.8.1 loader structure, shared by the unsigned-stage patch and
// archive verifier. Each of the two pinned distribution roles must be present.
export const WINDOWS_NATIVE_REQUIRE_ORIGINAL = String.raw`function tryNativeRequireJavaScriptModule(modulePath, options = {}) {
	if (process.platform === "win32" && options.allowWindows !== true) return { ok: false };
	if (!isJavaScriptModulePath(modulePath)) return { ok: false };
	try {
		return {
			ok: true,
			moduleExport: requireWithOptionalAliases(modulePath, options.aliasMap)
		};
	} catch (error) {
		const code = error && typeof error === "object" ? error.code : void 0;
		if (isSourceTransformFallbackError(error, modulePath) || options.fallbackOnNativeError || options.fallbackOnMissingDependency === true && (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND")) return { ok: false };
		throw error;
	}
}`
export const WINDOWS_NATIVE_REQUIRE_PATCHED = WINDOWS_NATIVE_REQUIRE_ORIGINAL.replace(
  '\tif (!isJavaScriptModulePath(modulePath))',
  `\tif (/^file:/i.test(modulePath)) {
\t\tconst nativeUrl = new URL(modulePath);
\t\tif (modulePath.includes("?") || modulePath.includes("#") || /%2f|%5c/i.test(nativeUrl.pathname)) throw new TypeError("Native module file URL must preserve its exact identity");
\t\tmodulePath = fileURLToPath(nativeUrl);
\t}
\tif (!isJavaScriptModulePath(modulePath))`,
)

export const WINDOWS_WORKER_NATIVE_REQUIRE_ORIGINAL = "function tryNativeRequireJavaScriptModule(Ot,Zt={}){if(process.platform===`win32`&&Zt.allowWindows!==!0||!isJavaScriptModulePath(Ot))return{ok:!1};try{return{ok:!0,moduleExport:requireWithOptionalAliases(Ot,Zt.aliasMap)}}catch(_n){let Dn=_n&&typeof _n==`object`?_n.code:void 0;if(isSourceTransformFallbackError(_n,Ot)||Zt.fallbackOnNativeError||Zt.fallbackOnMissingDependency===!0&&(Dn===`MODULE_NOT_FOUND`||Dn===`ERR_MODULE_NOT_FOUND`))return{ok:!1};throw _n}}"
export const WINDOWS_WORKER_NATIVE_REQUIRE_PATCHED = "function tryNativeRequireJavaScriptModule(Ot,Zt={}){if(process.platform===`win32`&&Zt.allowWindows!==!0)return{ok:!1};if(/^file:/i.test(Ot)){let nativeUrl=new URL(Ot);if(Ot.includes(\"?\")||Ot.includes(\"#\")||/%2f|%5c/i.test(nativeUrl.pathname))throw new TypeError(\"Native module file URL must preserve its exact identity\");Ot=fileURLToPath(nativeUrl)}if(!isJavaScriptModulePath(Ot))return{ok:!1};try{return{ok:!0,moduleExport:requireWithOptionalAliases(Ot,Zt.aliasMap)}}catch(_n){let Dn=_n&&typeof _n==`object`?_n.code:void 0;if(isSourceTransformFallbackError(_n,Ot)||Zt.fallbackOnNativeError||Zt.fallbackOnMissingDependency===!0&&(Dn===`MODULE_NOT_FOUND`||Dn===`ERR_MODULE_NOT_FOUND`))return{ok:!1};throw _n}}"

// These byte contracts cover the complete installed 2026.8.1 prefix (byte 0
// through the native region boundary) and the entire native region, including
// alias hooks and error classification. They prove the readable helper is top-level
// without importing a parser before npm ci. Any upstream drift needs review.
const NATIVE_REGION = '//#region src/plugins/native-module-require.ts'
const NATIVE_PREFIX_SHA256 = '50d9c9cfbd6565ebf4bc5551a8029761357f1d91731bf54745eab6119778699d'
const NATIVE_REGION_ORIGINAL_SHA256 = 'fed9aad37254cca350ad67285fbd6ceb8b934267da59f3f206ffb21349a9e93f'
const NATIVE_REGION_PATCHED_SHA256 = '94896ad71ef20c109e9aba0225e2749c30561436efc184a8db73967c422260c6'
const nativeDigest = value => createHash('sha256').update(value, 'utf8').digest('hex')
// Count even commented/generator declaration spellings outside the pinned
// region; a second declaration must never evade uniqueness through trivia.
const nativeTrivia = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n]*)*`
const nativeDeclaration = String.raw`\bfunction${nativeTrivia}\*?${nativeTrivia}tryNativeRequireJavaScriptModule${nativeTrivia}\(`

// Only this flagged, isolated subprocess imports SourceTextModule. It parses
// three variants, never links/evaluates, and never prints the engine source.
function verifyWorkerTopLevel(source, start, end, name = 'tryNativeRequireJavaScriptModule', label = 'Windows worker') {
  const parser = `import { SourceTextModule } from 'node:vm';
import { readFileSync } from 'node:fs';
try {
  const source=readFileSync(0,'utf8');
  const [start,end]=process.argv.slice(1).map(Number);
  const name=process.argv[3];
  const sentinel='\\nconst '+name+'=0;';
  new SourceTextModule(source);
  let duplicate=false;
  try { new SourceTextModule(source+sentinel); }
  catch(error) { duplicate=error instanceof SyntaxError && error.message.includes("Identifier '"+name+"' has already been declared"); }
  if(!duplicate) throw new Error();
  new SourceTextModule(source.slice(0,start)+source.slice(end)+sentinel);
} catch { process.stderr.write('Worker top-level contract failed\\n');process.exitCode=1; }
`
  const env={...process.env}
  for(const key of Object.keys(env)) if(['NODE_OPTIONS','NODE_PATH'].includes(key.toUpperCase())) delete env[key]
  try {
    execFileSync(process.execPath,['--experimental-vm-modules','--no-warnings','--input-type=module','-e',parser,String(start),String(end),name],
      {input:source,encoding:'utf8',env,stdio:['pipe','pipe','pipe'],timeout:60000,maxBuffer:65536})
  } catch { assert.fail(`${label} top-level uniqueness structure drift`) }
}

export function inspectWindowsNativeRequireSources(sources, { allowUnpatched = false } = {}) {
  const declarations = []
  const regions = []
  for (const entry of sources) {
    for (const match of entry.source.matchAll(new RegExp(nativeDeclaration, 'g'))) {
      declarations.push({ ...entry, start: match.index })
    }
    for (const match of entry.source.matchAll(/\/\/#region src\/plugins\/native-module-require\.ts/g)) {
      regions.push({ path: entry.path, start: match.index })
    }
  }
  const workerPath = entry => /(?:^|\/)dist\/worker\/worker\.mjs$/.test(entry.path.replaceAll('\\','/'))
  const workers=declarations.filter(workerPath)
  const readable=declarations.filter(entry=>!workerPath(entry))
  assert.equal(readable.length,1,'Windows native loader requires exactly one readable helper')
  assert.equal(workers.length,1,'Windows native loader requires exactly one worker helper')
  assert.equal(declarations.length,2,'Windows native loader requires exactly two role helpers')
  assert.equal(regions.length,1,'Windows native loader region drift')
  const helper=readable[0]
  const regionStart = helper.source.indexOf(NATIVE_REGION)
  assert.ok(regions[0].path === helper.path && regionStart >= 0 && regionStart < helper.start,
    'Windows native loader region drift')
  const prefix = helper.source.slice(0, regionStart)
  assert.equal(prefix.split('import { fileURLToPath, pathToFileURL } from "node:url";').length - 1, 1,
    'Windows native loader unaliased fileURLToPath import drift')
  assert.equal(nativeDigest(prefix), NATIVE_PREFIX_SHA256, 'Windows native loader prefix structure drift')
  const regionEnd = helper.source.indexOf('//#endregion', regionStart)
  assert.ok(regionEnd >= helper.start, 'Windows native loader region drift')
  const region = helper.source.slice(regionStart, regionEnd + '//#endregion'.length)
  const digest = nativeDigest(region)
  assert.ok(digest === NATIVE_REGION_PATCHED_SHA256
    || (allowUnpatched && digest === NATIVE_REGION_ORIGINAL_SHA256),
  'Windows native loader compatibility patch missing or region structure drifted')
  const body = digest === NATIVE_REGION_PATCHED_SHA256 ? WINDOWS_NATIVE_REQUIRE_PATCHED : WINDOWS_NATIVE_REQUIRE_ORIGINAL
  assert.equal(helper.source.slice(helper.start, helper.start + body.length), body,
    'Windows native loader helper structure drift')
  const main={...helper,end:helper.start+body.length,body,patchedBody:WINDOWS_NATIVE_REQUIRE_PATCHED,role:'readable'}
  const worker=workers[0]
  const prefixEnd=worker.source.indexOf('from"node:url";')+'from"node:url";'.length
  assert.equal(nativeDigest(worker.source.slice(0,prefixEnd)),
    'a9e6d197b73b008b8d39943487a9538d766d42f6f3a86d1dfaef5e8e84accfa8','Windows worker prefix/import structure drift')
  const blockStart=worker.source.indexOf('function toSafeImportPath(')
  const blockEnd=worker.source.indexOf('function readPackageName$2(',blockStart)
  assert.ok(blockStart>=prefixEnd && blockStart<worker.start && blockEnd>worker.start,'Windows worker block structure drift')
  const blockDigest=nativeDigest(worker.source.slice(blockStart,blockEnd))
  const patched=blockDigest==="b01eb831c1af8ba0b41f62bc61b34cac9d4b5c85cff3c579f8711e571b955471"
  assert.ok(patched || (allowUnpatched && blockDigest==='f633f61a12aea474465ba784f813ae53e6939b2ff4f12f0f769ce73cdbbc48f8'),
    'Windows worker compatibility patch missing or block structure drifted')
  const workerBody=patched?WINDOWS_WORKER_NATIVE_REQUIRE_PATCHED:WINDOWS_WORKER_NATIVE_REQUIRE_ORIGINAL
  assert.equal(worker.source.slice(worker.start,worker.start+workerBody.length),workerBody,'Windows worker helper structure drift')
  verifyWorkerTopLevel(worker.source,worker.start,worker.start+workerBody.length)
  return [main,{...worker,end:worker.start+workerBody.length,body:workerBody,patchedBody:WINDOWS_WORKER_NATIVE_REQUIRE_PATCHED,role:'worker'}]
}

// User-approved fresh-state namespace switch: old CLIs are unsupported for new
// state. No old locks are migrated/deleted; SQLite coordination stays upstream.
// Exact pinned 2026.8.1 functions change only their two suffix literals.
export const LIFECYCLE_PATH_READABLE_ORIGINAL = "function resolveLifecycleCoordinatorPath(family, params) {\n\tconst canonicalDatabasePath = resolvePathViaExistingAncestorSync(params.databasePath);\n\tconst canonicalRuntimeDirectory = resolvePathViaExistingAncestorSync(params.runtimeDirectory);\n\tconst suffix = params.uid === void 0 ? \"openclaw-state-locks\" : `openclaw-state-locks-${params.uid}`;\n\treturn path.join(canonicalRuntimeDirectory, suffix, `${family}.${sha256HexPrefixCore(canonicalDatabasePath, 8)}.lock.sqlite`);\n}"
export const LIFECYCLE_PATH_WORKER_ORIGINAL = "function resolveLifecycleCoordinatorPath(Ot,Zt){let _n=resolvePathViaExistingAncestorSync(Zt.databasePath),Dn=resolvePathViaExistingAncestorSync(Zt.runtimeDirectory),kn=Zt.uid===void 0?`openclaw-state-locks`:`openclaw-state-locks-${Zt.uid}`;return path.join(Dn,kn,`${Ot}.${sha256HexPrefixCore(_n,8)}.lock.sqlite`)}"
export const LIFECYCLE_PATH_ROLES = [
  { role: 'main', path: /(?:^|\/)dist\/state-database-coordinator-[^/]+\.js$/, body: LIFECYCLE_PATH_READABLE_ORIGINAL },
  { role: 'config-doctor', path: /(?:^|\/)dist\/config-doctor\/official-external-plugin-catalog-snapshot-store-[^/]+\.js$/, body: LIFECYCLE_PATH_READABLE_ORIGINAL },
  { role: 'worker', path: /(?:^|\/)dist\/worker\/worker\.mjs$/, body: LIFECYCLE_PATH_WORKER_ORIGINAL },
]
export function inspectLifecycleCoordinatorSources(sources, { allowUnpatched = false } = {}) {
  const declarations = sources.flatMap(entry => [...entry.source.matchAll(
    new RegExp(String.raw`\bfunction${nativeTrivia}\*?${nativeTrivia}resolveLifecycleCoordinatorPath${nativeTrivia}\(`, 'g'),
  )].map(match => ({ ...entry, start: match.index })))
  assert.equal(declarations.length, 3, 'Lifecycle coordinator requires exactly three role helpers')
  const inspected = LIFECYCLE_PATH_ROLES.map(({role, path, body}) => {
    assert.equal(sources.filter(entry => path.test(entry.path.replaceAll('\\', '/'))).length, 1,
      `Lifecycle coordinator requires exactly one ${role} role file`)
    const entries = declarations.filter(entry => path.test(entry.path.replaceAll('\\', '/')))
    assert.equal(entries.length, 1, `Lifecycle coordinator requires exactly one ${role} helper`)
    const entry = entries[0]
    const patchedBody = body.replaceAll('openclaw-state-locks', 'uniopc-state-locks')
    const patched = entry.source.slice(entry.start, entry.start + patchedBody.length) === patchedBody
    assert.ok(patched || (allowUnpatched && entry.source.slice(entry.start, entry.start + body.length) === body),
      `Lifecycle coordinator ${role} suffix patch missing or function structure drift`)
    const matchedBody = patched ? patchedBody : body
    // Parse only: prove this exact range is the unique top-level executable
    // declaration, rather than matching bytes inside comments, strings or scopes.
    verifyWorkerTopLevel(entry.source, entry.start, entry.start + matchedBody.length,
      'resolveLifecycleCoordinatorPath', `Lifecycle coordinator ${role}`)
    return {...entry, role, body: matchedBody, patchedBody}
  })
  // No extra legacy suffix may hide in another chunk or outside the helper.
  const legacyCount = sources.reduce((count, entry) => count + entry.source.split('openclaw-state-locks').length - 1, 0)
  const expectedLegacyCount = inspected.filter(entry => entry.body !== entry.patchedBody).length * 2
  assert.equal(legacyCount, expectedLegacyCount, 'Lifecycle coordinator residual legacy suffix outside pinned helpers')
  return inspected
}

export function assertRuntimeEntryNamesBranded(names) {
  const violations = names.map(name => name.replace(/^\.\//, '')).filter(name => (
    /openclaw|小龙虾/i.test(name)
    && (/\/@openclaw(?:\/|$)/i.test(name) || /\/(?:openclaw\.mjs|openclaw\.plugin\.json)$/i.test(name)
      || (BRANDED_ENGINE_ROOT.test(name) && /\/dist\/.*openclaw[^/]*\.(?:js|mjs|cjs|d\.ts|d\.mts|png)$/i.test(name) && !/\/openclaw\.plugin\.json$/i.test(name))
      || !BRANDED_ENGINE_ROOT.test(name))
  ))
  assert.deepEqual(violations, [], `Unbranded runtime path(s): ${violations.join(', ')}`)
}

export function assertRuntimeWorkspaceTemplatesPackaged(names) {
  const normalized = names.map(name => name.replace(/^\.\//, ''))
  const templateRoot = normalized.find(name => /^tools\/node(?:-v[^/]+)?\/(?:lib\/)?node_modules\/uniopc-engine\/docs\/reference\/templates\/AGENTS\.md$/.test(name))
  assert.ok(templateRoot, 'Runtime archive must include the AGENTS.md workspace template')
  const templateDirectory = templateRoot.slice(0, -'AGENTS.md'.length)
  for (const required of ['SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md']) {
    assert.ok(normalized.includes(`${templateDirectory}${required}`), `Runtime archive must include ${required}`)
  }
}

export function listResidualRuntimePaths(names) {
  const residuals = new Set()
  for (const rawName of names) {
    const name = rawName.replace(/^\.\//, '')
    if (!/openclaw|小龙虾/i.test(name)) continue
    const scoped = name.match(/^tools\/node(?:-v[^/]+)?\/(?:lib\/)?node_modules\/@openclaw\/[^/]+/i)
    residuals.add(scoped?.[0] || name)
  }
  return [...residuals].sort()
}

export function assertRuntimeTextBranded(text, label = 'runtime text') {
  let checked = text
  for (const allowed of LEGAL_ATTRIBUTION_LINES) checked = checked.split(allowed).join('')
  // Match visible brand words, while leaving OpenClaw-derived code identifiers
  // and protocol constants intact for upstream package self-resolution.
  const match = checked.match(/(?<![A-Za-z0-9_])OpenClaw(?![A-Za-z0-9_])|小龙虾/)
  assert.equal(match, null, `Unbranded user-facing runtime string in ${label}: ${match?.[0]}`)
}

function assertRuntimeFileTextBranded(text, label) {
  const lines = text.split(/\r?\n/)
  const violations = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    let line = lines[lineIndex]
    for (const allowed of LEGAL_ATTRIBUTION_LINES) line = line.split(allowed).join('')
    if (/(?<![A-Za-z0-9_])OpenClaw(?![A-Za-z0-9_])|小龙虾/i.test(line)) {
      violations.push(`${label}:${lineIndex + 1}`)
    }
  }
  return violations
}

const USER_VISIBLE_METADATA_KEYS = new Set(['description', 'displayName', 'title', 'productName', 'shortDescription'])
const INTERNAL_TEXT_ALLOWLIST = [
  {
      path: /\/uniopc-engine\/dist\/control-ui[^/]*\.js$/i,
    reason: 'Compiled Control UI retains internal API/property identifiers; standalone UI brand words are patched during bundle preparation.',
  },
  {
    path: /\/node_modules\/@uniopc\/[^/]+\/dist\/[^/]+\.m?js$/i,
    reason: 'Bundled upstream AI SDK code retains immutable package and protocol identifiers.',
  },
  {
    path: /\/pnpm-workspace\.yaml$/i,
    reason: 'Upstream workspace configuration uses package aliases required by the installed dependency graph.',
  },
]

export function classifyInternalTextPath(path) {
  return INTERNAL_TEXT_ALLOWLIST.find(rule => rule.path.test(`/${path.replace(/^\//, '')}`))?.reason ?? null
}

function countBrandOccurrences(text) {
  return [...text.matchAll(/OpenClaw|小龙虾/gi)].length
}

function collectVisibleMetadata(value, key = '', found = []) {
  if (typeof value === 'string') {
    if (USER_VISIBLE_METADATA_KEYS.has(key)) found.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectVisibleMetadata(item, key, found)
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) collectVisibleMetadata(child, childKey, found)
  }
  return found
}

function isReadableText(buffer) {
  if (buffer.includes(0)) return false
  const decoded = buffer.toString('utf8')
  return !decoded.includes('\uFFFD')
}

async function walk(directory, callback) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, callback)
    else if (entry.isFile()) await callback(path)
  }
}

function tarBin() {
  if (process.platform !== 'win32') return 'tar'
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return join(root, 'System32', 'tar.exe')
}

export async function verifyRuntimeDirectory(runtimeDirectory = RUNTIME_DIR) {
  const catalogText = await readFile(join(runtimeDirectory, CATALOG), 'utf8')
  const textViolations = assertRuntimeFileTextBranded(catalogText, CATALOG)
  const catalog = JSON.parse(catalogText)
  assert.ok(Array.isArray(catalog.artifacts) && catalog.artifacts.length > 0, 'runtime catalog must contain artifacts')
  const residualPaths = new Set()
  const internalTextResiduals = new Map()
  for (const artifact of catalog.artifacts) {
    assert.ok(/^uniopc-engine-runtime-[a-z0-9-]+\.tar\.gz$/i.test(artifact.archive), `unbranded archive name required: ${artifact.archive}`)
    const archive = join(runtimeDirectory, artifact.archive)
    const names = execFileSync(tarBin(), ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split(/\r?\n/).filter(Boolean)
    assertRuntimeEntryNamesBranded(names)
    assertRuntimeWorkspaceTemplatesPackaged(names)
    for (const name of listResidualRuntimePaths(names)) residualPaths.add(name)
    const stage = await mkdtemp(join(tmpdir(), 'uniopc-runtime-brand-scan-'))
    try {
      execFileSync(tarBin(), ['-xzf', archive, '-C', stage], { stdio: 'ignore' })
      const nativeLoaderSources = []
      const lifecycleSources = []
      await walk(stage, async path => {
        const rel = path.slice(stage.length + 1).replaceAll('\\', '/')
        const normalized = rel.replace(/^\.\//, '')
        const lifecycleCandidate = BRANDED_ENGINE_ROOT.test(normalized)
          && /^dist\/.*\.[cm]?js$/i.test(normalized.replace(BRANDED_ENGINE_ROOT, ''))
        const nativeCandidate = artifact.platform === 'win32' && BRANDED_ENGINE_ROOT.test(normalized)
          && /\/uniopc-engine\/dist\/.*\.[cm]?js$/i.test(normalized) && !/\/node_modules\//.test(normalized.split('/uniopc-engine/')[1])
        // Native contracts inspect bytes independently of branding's readability
        // heuristic: a literal replacement character is valid UTF-8 source.
        if (nativeCandidate) {
          const nativeBytes = await readFile(path).catch(() => assert.fail(`Unreadable Windows native loader candidate: ${normalized}`))
          assert.ok(!nativeBytes.includes(0), `NUL in Windows native loader candidate: ${normalized}`)
          const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(nativeBytes)
          nativeLoaderSources.push({ path: normalized, source })
        }
        if (lifecycleCandidate) {
          const bytes = await readFile(path)
          assert.ok(!bytes.includes(0), `NUL in lifecycle coordinator source: ${normalized}`)
          lifecycleSources.push({path: normalized, source: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes)})
        }
        const bytes = await readFile(path).catch(() => null)
        if (bytes === null || !isReadableText(bytes)) return
        const text = bytes.toString('utf8')
        const internalReason = classifyInternalTextPath(normalized)
        if (internalReason) {
          const count = countBrandOccurrences(text)
          if (count) internalTextResiduals.set(normalized, { count, reason: internalReason })
          return
        }
        const engineRelative = normalized.replace(BRANDED_ENGINE_ROOT, '')
        if (BRANDED_ENGINE_ROOT.test(normalized) && isManagedSkillMarkdown(engineRelative)) {
          for (const occurrence of skillBrandOccurrences(text)) {
            textViolations.push(`${normalized}:${text.slice(0, occurrence.start).split('\n').length}`)
          }
          return
        }
        if (/\.json$/i.test(normalized)) {
          try {
            const metadata = JSON.parse(text)
            if (/\/cli-startup-metadata\.json$/i.test(normalized)) {
              for (const key of ['browserHelpText', 'secretsHelpText', 'nodesHelpText', 'rootHelpText']) {
                if (typeof metadata[key] !== 'string') throw new Error(`Missing ${key} in ${normalized}`)
                try { assertRuntimeTextBranded(metadata[key], `${normalized}:${key}`) }
                catch { textViolations.push(`${normalized}:${key}`) }
              }
              if (!metadata.subcommandHelpText || typeof metadata.subcommandHelpText !== 'object') {
                throw new Error(`Missing subcommandHelpText in ${normalized}`)
              }
              for (const [command, help] of Object.entries(metadata.subcommandHelpText)) {
                if (typeof help !== 'string') throw new Error(`Invalid help text for ${command} in ${normalized}`)
                try { assertRuntimeTextBranded(help, `${normalized}:subcommandHelpText.${command}`) }
                catch { textViolations.push(`${normalized}:subcommandHelpText.${command}`) }
              }
            }
            for (const value of collectVisibleMetadata(metadata)) {
              textViolations.push(...assertRuntimeFileTextBranded(value, normalized))
            }
          } catch {
            // Non-JSON files with a JSON-like suffix are checked as readable text below.
            textViolations.push(...assertRuntimeFileTextBranded(text, normalized))
          }
        } else if (/\.(?:js|mjs)$/i.test(normalized)
          && /\/dist\//i.test(`/${normalized}`)
          && /\/node_modules\/uniopc-engine\//i.test(`/${normalized}`)) {
          try {
            assertRuntimeTextBranded(text, normalized)
          } catch {
            textViolations.push(normalized)
          }
        } else if (/\.(?:html|txt|xml|yaml|yml|toml)$/i.test(normalized)
          || /\/docs\/reference\/templates\/[^/]+\.md$/i.test(normalized)) {
          textViolations.push(...assertRuntimeFileTextBranded(text, normalized))
        }
      })
      if (artifact.platform === 'win32') inspectWindowsNativeRequireSources(nativeLoaderSources)
      inspectLifecycleCoordinatorSources(lifecycleSources)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
  assert.deepEqual(textViolations, [], `Unbranded runtime text occurrence(s):\n${textViolations.join('\n')}`)
  return {
    artifactCount: catalog.artifacts.length,
    residualPaths: [...residualPaths].sort(),
    internalTextResiduals: [...internalTextResiduals.entries()].sort(([a], [b]) => a.localeCompare(b)),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]
  if (target === '--help' || target === '-h') {
    console.log('Usage: node scripts/verify-uniopc-whitelabel-runtime.mjs [runtime-directory]')
    process.exit(0)
  }
  verifyRuntimeDirectory(target ? resolve(target) : RUNTIME_DIR)
    .then(result => {
      console.log(`Uniopc runtime branding verified (${result.artifactCount} artifact(s)).`)
      console.log(`Allowed upstream package path residuals (${result.residualPaths.length}):`)
      for (const path of result.residualPaths) console.log(`  ${path}`)
      console.log(`Allowed upstream internal text residuals (${result.internalTextResiduals.length} file(s)):`)
      for (const [path, entry] of result.internalTextResiduals) {
        console.log(`  ${path} (${entry.count} occurrence(s)): ${entry.reason}`)
      }
    })
    .catch(error => { console.error(error); process.exitCode = 1 })
}
