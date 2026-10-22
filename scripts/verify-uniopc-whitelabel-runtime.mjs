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

export function isTechnicalPackageName(value) {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value)
}

// Fresh-install generated state contract for pinned engine 2026.8.1. Counts are
// roles, not a global search/replace: unknown chunks and partially converted roles
// must fail before the converter can write any bytes or rename a chunk.
export const GENERATED_STATE_ROLES = [
  {
    "role": "worker/worker.mjs",
    "counts": [
      31,
      1,
      10
    ]
  },
  {
    "role": "config-doctor/official-external-plugin-catalog-snapshot-store-DAJ2jZEn.js",
    "counts": [
      2,
      0,
      2
    ]
  },
  {
    "role": "backup-verify-B70_GdSp.js",
    "counts": [
      6,
      0,
      3
    ]
  },
  {
    "role": "uniopc-agent-db.paths-BAQb87PB.js",
    "counts": [
      1,
      1,
      0
    ]
  },
  {
    "role": "uniopc-state-db-Cb4e1jdd.js",
    "counts": [
      2,
      0,
      0
    ]
  },
  {
    "role": "uniopc-state-db-readonly-YhcJ4nbp.js",
    "counts": [
      0,
      0,
      1
    ]
  },
  {
    "role": "session-sqlite-target-Cc4hugKW.js",
    "counts": [
      5,
      0,
      0
    ]
  },
  {
    "role": "setup.migration-import-DAMi9dFU.js",
    "counts": [
      3,
      0,
      0
    ]
  },
  {
    "role": "sqlite-B1Zreme7.js",
    "counts": [
      2,
      0,
      0
    ]
  },
  {
    "role": "state-migrations.doctor-hQ0ipR8Y.js",
    "counts": [
      2,
      0,
      0
    ]
  },
  {
    "role": "agents-DtyKDwum.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "backup-AYb2BIZo.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "backup-archive-path-policy-DKQb_csh.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "doctor-health-Or1mnORJ.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "path-resolve-FSTOqqc1.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "paths-69D1xQRn.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "progress-card-M8eg67-8.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "runtime-snapshots-CUnHyAF9.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "sessions-DI996Ow5.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "setup-inference-_C0MGz6R.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "state-migrations.media-persistence-targets-CXLKvWg2.js",
    "counts": [
      1,
      0,
      0
    ]
  },
  {
    "role": "config-guard-B5weYmpD.js",
    "counts": [
      0,
      0,
      1
    ]
  },
  {
    "role": "crypto-state-store-vlKMG4Bz.js",
    "counts": [
      0,
      0,
      1
    ]
  },
  {
    "role": "doctor-retired-phone-control-CqziMC7b.js",
    "counts": [
      0,
      0,
      1
    ]
  },
  {
    "role": "gateway-lock-B3SaVvYo.js",
    "counts": [
      0,
      0,
      1
    ]
  },
  {
    "role": "official-external-plugin-catalog-snapshot-store-Dtjb9xIi.js",
    "counts": [
      0,
      0,
      1
    ]
  },
  {
    "role": "storage-Bun7RN57.js",
    "counts": [
      0,
      0,
      1
    ]
  },
  {
    "role": "store-sqlite-record-ByiMFhcJ.js",
    "counts": [
      0,
      0,
      1
    ]
  },
  {
    "role": "exec-approvals-config-QmzK42j1.js",
    "counts": [
      0,
      0,
      3
    ]
  }
]
export const GENERATED_STATE_FUNCTIONS = [
  {
    "role": "session-sqlite-target-Cc4hugKW.js",
    "name": "resolveUnsuffixedSqliteTargetFromSessionStorePath",
    "body": "function resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath) {\n\tconst resolved = path.resolve(storePath);\n\tif (path.basename(resolved) === \"openclaw-agent.sqlite\" || resolved.endsWith(\".sqlite\")) {\n\t\tconst agentId = resolveAgentIdFromSqliteDatabasePath(resolved);\n\t\treturn {\n\t\t\tpath: resolved,\n\t\t\t...agentId ? { agentId } : {}\n\t\t};\n\t}\n\tconst sessionsDir = path.dirname(resolved);\n\tif (path.basename(resolved) !== \"sessions.json\") {\n\t\tconst sqliteBaseName = path.basename(resolved, path.extname(resolved)) || \"openclaw-agent\";\n\t\treturn { path: path.join(sessionsDir, `${sqliteBaseName}.sqlite`) };\n\t}\n\tif (path.basename(sessionsDir) !== \"sessions\") return { path: path.join(sessionsDir, \"openclaw-agent.sqlite\") };\n\tconst agentDir = path.dirname(sessionsDir);\n\tif (path.basename(path.dirname(agentDir)) !== \"agents\") return { path: path.join(sessionsDir, \"openclaw-agent.sqlite\") };\n\treturn {\n\t\tagentId: normalizeAgentId(path.basename(agentDir)),\n\t\tpath: path.join(agentDir, \"agent\", \"openclaw-agent.sqlite\")\n\t};\n}"
  },
  {
    "role": "uniopc-cli-invocation-Dah1vX_Z.js",
    "name": "buildPackageRootCliArgs",
    "body": "function buildPackageRootCliArgs(packageRoot, execPath) {\n\tconst sourceEntry = path.join(packageRoot, \"src\", \"entry.ts\");\n\tif (fs.existsSync(sourceEntry)) {\n\t\tif (isBunRuntime(execPath)) return [sourceEntry];\n\t\ttry {\n\t\t\treturn [\n\t\t\t\t\"--import\",\n\t\t\t\tresolveTsxImport(packageRoot),\n\t\t\t\tsourceEntry\n\t\t\t];\n\t\t} catch {}\n\t}\n\treturn [path.join(packageRoot, \"openclaw.mjs\")];\n}"
  },
  {
    "role": "uniopc-cli-invocation-Dah1vX_Z.js",
    "name": "resolveCurrentOpenClawCliInvocation",
    "body": "function resolveCurrentOpenClawCliInvocation(args, options = {}) {\n\tconst execPath = options.execPath ?? process.execPath;\n\tconst entry = (options.argv1 ?? process.argv[1])?.trim();\n\tconst cwd = options.cwd ?? tryProcessCwd();\n\tconst entryPackageRoot = entry ? resolveOpenClawPackageRootSync({ argv1: entry }) : null;\n\tconst packageRoot = entryPackageRoot ?? resolveOpenClawPackageRootSync({\n\t\targv1: entry,\n\t\tcwd,\n\t\tmoduleUrl: options.moduleUrl ?? import.meta.url\n\t});\n\tconst invocationCwd = packageRoot ?? cwd ?? (entry ? path.dirname(path.resolve(entry)) : path.dirname(execPath));\n\tconst sourceEntry = packageRoot ? path.join(packageRoot, \"src\", \"entry.ts\") : void 0;\n\tconst currentEntry = entry && entry !== execPath && entryPackageRoot && (OPENCLAW_CLI_ENTRY_BASENAMES.has(path.basename(entry)) || OPENCLAW_PACKAGE_ENTRY_PATHS.has(path.relative(path.resolve(entryPackageRoot), path.resolve(entry)))) ? entry : void 0;\n\tconst cliArgs = currentEntry ? [...filterOpenClawChildExecArgv(options.execArgv ?? process.execArgv, currentEntry === sourceEntry && !isBunRuntime(execPath) ? packageRoot ?? void 0 : void 0), currentEntry] : packageRoot ? buildPackageRootCliArgs(packageRoot, execPath) : entry && entry !== execPath ? [entry] : [];\n\tconst env = packageRoot && !isBunRuntime(execPath) && cliArgs.at(-1) === sourceEntry ? { TSX_TSCONFIG_PATH: path.join(packageRoot, \"tsconfig.json\") } : void 0;\n\treturn {\n\t\tcommand: execPath,\n\t\targs: [...cliArgs, ...args],\n\t\tcwd: invocationCwd,\n\t\t...env ? { env } : {}\n\t};\n}"
  },
  {
    "role": "uniopc-cli-shim-BECwG_UE.js",
    "name": "prepareGatewayAgentCliShim",
    "body": "async function prepareGatewayAgentCliShim(options = {}) {\n\tconst env = options.env ?? process.env;\n\tconst platform = options.platform ?? process.platform;\n\tconst invocation = options.invocation ?? resolveCurrentOpenClawCliInvocation([]);\n\tconst profile = normalizeProfileName(env.OPENCLAW_PROFILE);\n\tconst binDir = path.join(options.stateDir ?? resolveStateDir(env), AGENT_CLI_BIN_DIR);\n\tconst executablePath = path.join(binDir, platform === \"win32\" ? \"openclaw.cmd\" : \"openclaw\");\n\tconst content = platform === \"win32\" ? renderWindowsShim(invocation, profile) : renderPosixShim(invocation, profile);\n\tawait fs.mkdir(binDir, {\n\t\trecursive: true,\n\t\tmode: 448\n\t});\n\tawait fs.chmod(binDir, 448).catch(() => void 0);\n\tawait writeTextAtomic(executablePath, content, {\n\t\tmode: 448,\n\t\tdirMode: 448,\n\t\tdurable: false,\n\t\ttempPrefix: \"openclaw-agent-cli\"\n\t});\n\tgatewayAgentCliState.binDir = binDir;\n}"
  },
  {
    "role": "worker/worker.mjs",
    "name": "resolveUnsuffixedSqliteTargetFromSessionStorePath",
    "body": "function resolveUnsuffixedSqliteTargetFromSessionStorePath(Ot){let Zt=path.resolve(Ot);if(path.basename(Zt)===`openclaw-agent.sqlite`||Zt.endsWith(`.sqlite`)){let Ot=resolveAgentIdFromSqliteDatabasePath(Zt);return{path:Zt,...Ot?{agentId:Ot}:{}}}let _n=path.dirname(Zt);if(path.basename(Zt)!==`sessions.json`){let Ot=path.basename(Zt,path.extname(Zt))||`openclaw-agent`;return{path:path.join(_n,`${Ot}.sqlite`)}}if(path.basename(_n)!==`sessions`)return{path:path.join(_n,`openclaw-agent.sqlite`)};let Dn=path.dirname(_n);return path.basename(path.dirname(Dn))===`agents`?{agentId:normalizeAgentId(path.basename(Dn)),path:path.join(Dn,`agent`,`openclaw-agent.sqlite`)}:{path:path.join(_n,`openclaw-agent.sqlite`)}}"
  },
  {
    "role": "worker/worker.mjs",
    "name": "buildPackageRootCliArgs",
    "body": "function buildPackageRootCliArgs(Ot,Zt){let _n=path.join(Ot,`src`,`entry.ts`);if(fs.existsSync(_n)){if(isBunRuntime(Zt))return[_n];try{return[`--import`,resolveTsxImport(Ot),_n]}catch{}}return[path.join(Ot,`openclaw.mjs`)]}"
  },
  {
    "role": "worker/worker.mjs",
    "name": "resolveCurrentOpenClawCliInvocation",
    "body": "function resolveCurrentOpenClawCliInvocation(Ot,Zt={}){let _n=Zt.execPath??process.execPath,Dn=(Zt.argv1??process.argv[1])?.trim(),kn=Zt.cwd??tryProcessCwd(),Pn=Dn?resolveOpenClawPackageRootSync({argv1:Dn}):null,Fn=Pn??resolveOpenClawPackageRootSync({argv1:Dn,cwd:kn,moduleUrl:Zt.moduleUrl??import.meta.url}),Ln=Fn??kn??(Dn?path.dirname(path.resolve(Dn)):path.dirname(_n)),Jn=Fn?path.join(Fn,`src`,`entry.ts`):void 0,cr=Dn&&Dn!==_n&&Pn&&(OPENCLAW_CLI_ENTRY_BASENAMES.has(path.basename(Dn))||OPENCLAW_PACKAGE_ENTRY_PATHS.has(path.relative(path.resolve(Pn),path.resolve(Dn))))?Dn:void 0,pr=cr?[...filterOpenClawChildExecArgv(Zt.execArgv??process.execArgv,cr===Jn&&!isBunRuntime(_n)?Fn??void 0:void 0),cr]:Fn?buildPackageRootCliArgs(Fn,_n):Dn&&Dn!==_n?[Dn]:[],xr=Fn&&!isBunRuntime(_n)&&pr.at(-1)===Jn?{TSX_TSCONFIG_PATH:path.join(Fn,`tsconfig.json`)}:void 0;return{command:_n,args:[...pr,...Ot],cwd:Ln,...xr?{env:xr}:{}}}"
  },
  {
    "role": "worker/worker.mjs",
    "name": "prepareGatewayAgentCliShim",
    "body": "async function prepareGatewayAgentCliShim(Ot={}){let Zt=Ot.env??process.env,_n=Ot.platform??process.platform,Dn=Ot.invocation??resolveCurrentOpenClawCliInvocation([]),kn=normalizeProfileName$1(Zt.OPENCLAW_PROFILE),Pn=path.join(Ot.stateDir??resolveStateDir(Zt),AGENT_CLI_BIN_DIR),Fn=path.join(Pn,_n===`win32`?`openclaw.cmd`:`openclaw`),Ln=_n===`win32`?renderWindowsShim(Dn,kn):renderPosixShim(Dn,kn);await fs$1.mkdir(Pn,{recursive:!0,mode:448}),await fs$1.chmod(Pn,448).catch(()=>void 0),await writeTextAtomic(Fn,Ln,{mode:448,dirMode:448,durable:!1,tempPrefix:`openclaw-agent-cli`}),gatewayAgentCliState.binDir=Pn}"
  },
  {
    "role": "backup-archive-path-policy-DKQb_csh.js",
    "name": "buildBackupArchiveRoot",
    "body": "function buildBackupArchiveRoot(nowMs = Date.now()) {\n\treturn `${formatBackupArchiveTimestamp(nowMs)}-openclaw-backup`;\n}"
  },
  {
    "role": "backup-AYb2BIZo.js",
    "name": "createBackupArchivePublication",
    "body": "async function createBackupArchivePublication(outputPath) {\n\tconst requestedOutputPath = path.resolve(outputPath);\n\tconst requestedParentPath = path.dirname(requestedOutputPath);\n\tconst canonicalParentPath = await fs$1.realpath(requestedParentPath);\n\tconst parentIdentity = await fs$1.lstat(canonicalParentPath);\n\tif (!parentIdentity.isDirectory()) throw new Error(`Backup output parent is not a directory: ${requestedParentPath}`);\n\tconst canonicalOutputPath = path.join(canonicalParentPath, path.basename(requestedOutputPath));\n\tawait assertTargetAbsent(canonicalOutputPath);\n\tconst stagingDir = await fs$1.mkdtemp(path.join(canonicalParentPath, `.openclaw-backup-publish-${randomUUID()}-`));\n\tlet stagingIdentity;\n\ttry {\n\t\tstagingIdentity = await fs$1.lstat(stagingDir);\n\t\tawait fs$1.chmod(stagingDir, 448);\n\t\treturn {\n\t\t\tcanonicalOutputPath,\n\t\t\tcanonicalParentPath,\n\t\t\tparentReceipt: {\n\t\t\t\tpath: canonicalParentPath,\n\t\t\t\trealPath: canonicalParentPath,\n\t\t\t\tidentity: parentIdentity\n\t\t\t},\n\t\t\tpendingCleanupArchives: [],\n\t\t\trequestedOutputPath,\n\t\t\trequestedParentPath,\n\t\t\tstagingDir,\n\t\t\tstagingIdentity,\n\t\t\ttempArchivePath: path.join(stagingDir, \"archive.tar.gz.tmp\")\n\t\t};\n\t} catch (error) {\n\t\tif (stagingIdentity) await removeDirectoryIfOwned(stagingDir, stagingIdentity);\n\t\tthrow error;\n\t}\n}"
  },
  {
    "role": "backup-AYb2BIZo.js",
    "name": "createBackupArchive",
    "body": "async function createBackupArchive(opts = {}) {\n\tconst nowMs = resolveDateTimestampMs(opts.nowMs);\n\tconst archiveRoot = buildBackupArchiveRoot(nowMs);\n\tconst onlyConfig = Boolean(opts.onlyConfig);\n\tconst includeWorkspace = onlyConfig ? false : opts.includeWorkspace ?? true;\n\tconst plan = await resolveBackupPlanFromDisk({\n\t\tincludeWorkspace,\n\t\tonlyConfig,\n\t\tnowMs\n\t});\n\tconst outputPath = await resolveOutputPath({\n\t\toutput: opts.output,\n\t\tnowMs,\n\t\tincludedAssets: plan.included,\n\t\tstateDir: plan.stateDir\n\t});\n\tif (plan.included.length === 0) throw new Error(onlyConfig ? \"No Uniopc config file was found to back up.\" : \"No local Uniopc state was found to back up.\");\n\tconst canonicalOutputPath = await canonicalizePathForContainment(outputPath);\n\tconst overlappingAsset = plan.included.find((asset) => isPathWithin(canonicalOutputPath, asset.sourcePath));\n\tif (overlappingAsset) throw new Error(`Backup output must not be written inside a source path: ${outputPath} is inside ${overlappingAsset.sourcePath}`);\n\tif (!opts.dryRun) await assertOutputPathReady(outputPath);\n\tconst createdAt = new Date(nowMs).toISOString();\n\tconst stateAsset = plan.included.find((asset) => asset.kind === \"state\");\n\tconst result = {\n\t\tcreatedAt,\n\t\tarchiveRoot,\n\t\tarchivePath: outputPath,\n\t\tdryRun: Boolean(opts.dryRun),\n\t\tincludeWorkspace,\n\t\tonlyConfig,\n\t\tverified: false,\n\t\tassets: plan.included,\n\t\t...onlyConfig ? {} : { agentRoots: plan.inventory.agentRoots.map(({ agentId, sourcePath }) => ({\n\t\t\tagentId,\n\t\t\tsourcePath\n\t\t})) },\n\t\tskipped: plan.skipped,\n\t\tskippedVolatileCount: 0\n\t};\n\tif (opts.dryRun) return result;\n\tawait prepareBackupOutputParent(outputPath);\n\tconst tempRoot = await chooseBackupTempRoot({\n\t\tassets: result.assets,\n\t\toutputPath\n\t});\n\tawait fs$1.mkdir(tempRoot, { recursive: true });\n\tconst tempDir = await fs$1.mkdtemp(path.join(tempRoot, \"openclaw-backup-\"));\n\tconst manifestPath = path.join(tempDir, \"manifest.json\");\n\tlet publication;\n\ttry {\n\t\tpublication = await createBackupArchivePublication(outputPath);\n\t} catch (error) {\n\t\tawait fs$1.rm(tempDir, {\n\t\t\trecursive: true,\n\t\t\tforce: true\n\t\t}).catch(() => void 0);\n\t\tthrow formatBackupOutputFailure(error, outputPath, \"publication\");\n\t}\n\tconst tempArchivePath = publication.tempArchivePath;\n\ttry {\n\t\tconst hasLegacyAuditSources = stateAsset ? await hasLegacyAuditBackupSources(stateAsset.sourcePath) : false;\n\t\tconst createSnapshotPlans = async () => {\n\t\t\tconst legacyAuditSnapshots = stateAsset && hasLegacyAuditSources ? await createLegacyAuditBackupSnapshots({\n\t\t\t\tstateDir: stateAsset.sourcePath,\n\t\t\t\ttempDir\n\t\t\t}) : [];\n\t\t\treturn {\n\t\t\t\tlegacyAuditSnapshots,\n\t\t\t\tstateSqliteBackup: !onlyConfig ? await createBackupSqliteSnapshotPlan({\n\t\t\t\t\tinventory: plan.inventory,\n\t\t\t\t\ttempDir,\n\t\t\t\t\tlegacyAuditSnapshots\n\t\t\t\t}) : {\n\t\t\t\t\tsnapshots: [],\n\t\t\t\t\tdiscoveredSourcePaths: /* @__PURE__ */ new Set()\n\t\t\t\t}\n\t\t\t};\n\t\t};\n\t\tconst { legacyAuditSnapshots, stateSqliteBackup } = stateAsset && hasLegacyAuditSources ? await withLegacyAuditMigrationLease(stateAsset.sourcePath, createSnapshotPlans) : await createSnapshotPlans();\n\t\tconst sourcePathRemaps = /* @__PURE__ */ new Map();\n\t\tconst skippedStateSourcePaths = /* @__PURE__ */ new Set();\n\t\tfor (const snapshot of stateSqliteBackup.snapshots) {\n\t\t\tsourcePathRemaps.set(path.resolve(snapshot.sourcePath), snapshot.archiveSourcePath);\n\t\t\tfor (const skippedSourcePath of snapshot.skippedSourcePaths) skippedStateSourcePaths.add(skippedSourcePath);\n\t\t}\n\t\tfor (const snapshot of legacyAuditSnapshots) {\n\t\t\tsourcePathRemaps.set(path.resolve(snapshot.sourcePath), snapshot.archiveSourcePath);\n\t\t\tfor (const skippedSourcePath of snapshot.skippedSourcePaths) skippedStateSourcePaths.add(skippedSourcePath);\n\t\t}\n\t\tconst manifest = buildManifest({\n\t\t\tcreatedAt,\n\t\t\tarchiveRoot,\n\t\t\tincludeWorkspace,\n\t\t\tonlyConfig,\n\t\t\tassets: result.assets,\n\t\t\tskipped: result.skipped,\n\t\t\tstateDir: plan.stateDir,\n\t\t\tconfigPath: plan.configPath,\n\t\t\toauthDir: plan.oauthDir,\n\t\t\tworkspaceDirs: plan.workspaceDirs,\n\t\t\tagentRoots: plan.inventory.agentRoots\n\t\t});\n\t\tawait writeJson(manifestPath, manifest, { trailingNewline: true });\n\t\tconst tar = await loadTarRuntime();\n\t\tconst gatewayLockDir = resolveGatewayLockDir(plan.stateDir);\n\t\tconst volatilePlan = { stateDirs: [stateAsset?.sourcePath ?? plan.stateDir] };\n\t\tlet skippedVolatileCount = 0;\n\t\tconst unexpectedSqliteSourcePaths = [];\n\t\tlet archiveSymlinkViolation;\n\t\tconst tarFilter = (entryPath, entryStat) => {\n\t\t\tconst resolvedEntryPath = path.resolve(entryPath);\n\t\t\tif (resolvedEntryPath === manifestPath) return true;\n\t\t\tconst isDirectory = \"isDirectory\" in entryStat ? entryStat.isDirectory() : entryStat.type === \"Directory\";\n\t\t\tif (!onlyConfig && !(isDirectory ? plan.inventory.isTraversable(resolvedEntryPath) : plan.inventory.isIncluded(resolvedEntryPath))) return false;\n\t\t\tif (isPathWithin(resolvedEntryPath, gatewayLockDir)) return false;\n\t\t\tif (stateAsset && isLegacyAuditMigrationBackupPath(resolvedEntryPath, stateAsset.sourcePath)) return false;\n\t\t\tconst sqliteSourceKind = onlyConfig ? void 0 : classifyBackupSqliteSource(resolvedEntryPath, plan.inventory);\n\t\t\tif (sqliteSourceKind === \"excluded\") return false;\n\t\t\tif (skippedStateSourcePaths.has(resolvedEntryPath)) return false;\n\t\t\tif (sqliteSourceKind === \"sqlite\" && stateSqliteBackup.discoveredSourcePaths.has(resolvedEntryPath)) return false;\n\t\t\tif (sqliteSourceKind === \"sqlite\" && isBackupTarFilterFile(entryStat)) {\n\t\t\t\tunexpectedSqliteSourcePaths.push(entryPath);\n\t\t\t\treturn false;\n\t\t\t}\n\t\t\tif (isVolatileBackupPath(entryPath, volatilePlan)) {\n\t\t\t\tskippedVolatileCount += 1;\n\t\t\t\treturn false;\n\t\t\t}\n\t\t\treturn true;\n\t\t};\n\t\tconst completedArchive = await writeTarArchiveWithRetry({\n\t\t\ttempArchivePath,\n\t\t\tlog: opts.log,\n\t\t\trunTar: async (attemptTempArchivePath) => {\n\t\t\t\tskippedVolatileCount = 0;\n\t\t\t\tunexpectedSqliteSourcePaths.length = 0;\n\t\t\t\tarchiveSymlinkViolation = void 0;\n\t\t\t\tconst prepared = await writeArchiveStreamToFile({\n\t\t\t\t\tarchivePath: attemptTempArchivePath,\n\t\t\t\t\tcreateArchiveStream: (reportProgress) => tar.c({\n\t\t\t\t\t\tgzip: true,\n\t\t\t\t\t\tportable: true,\n\t\t\t\t\t\tpreservePaths: true,\n\t\t\t\t\t\tlinkCache: createBackupLinkCache(),\n\t\t\t\t\t\tstatCache: createBackupVolatileStatCache(volatilePlan),\n\t\t\t\t\t\tfilter: (entryPath, entryStat) => {\n\t\t\t\t\t\t\treportProgress({\n\t\t\t\t\t\t\t\tphase: \"traversal\",\n\t\t\t\t\t\t\t\tentryPath\n\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\treturn tarFilter(entryPath, entryStat);\n\t\t\t\t\t\t},\n\t\t\t\t\t\tonWriteEntry: (entry) => {\n\t\t\t\t\t\t\tconst sourceEntryPath = entry.path;\n\t\t\t\t\t\t\treportProgress({\n\t\t\t\t\t\t\t\tphase: \"entry\",\n\t\t\t\t\t\t\t\tentryPath: sourceEntryPath\n\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\tif (entry.type === \"File\" && (entry.stat?.size ?? 0) > 0) observeBackupTarEntryProgress(entry, (bytes) => {\n\t\t\t\t\t\t\t\treportProgress({\n\t\t\t\t\t\t\t\t\tphase: \"raw\",\n\t\t\t\t\t\t\t\t\tentryPath: sourceEntryPath,\n\t\t\t\t\t\t\t\t\tbytes\n\t\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\tconst archiveEntryPath = remapArchiveEntryPath({\n\t\t\t\t\t\t\t\tentryPath: entry.path,\n\t\t\t\t\t\t\t\tmanifestPath,\n\t\t\t\t\t\t\t\tarchiveRoot,\n\t\t\t\t\t\t\t\tsourcePathRemaps\n\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\tif (entry.type === \"SymbolicLink\" && !archiveSymlinkViolation) try {\n\t\t\t\t\t\t\t\tassertArchiveSymbolicLinkTarget({\n\t\t\t\t\t\t\t\t\tarchiveRoot,\n\t\t\t\t\t\t\t\t\tentryPath: archiveEntryPath,\n\t\t\t\t\t\t\t\t\tlinkpath: entry.linkpath,\n\t\t\t\t\t\t\t\t\tassetArchivePaths: manifest.assets.map((asset) => asset.archivePath)\n\t\t\t\t\t\t\t\t});\n\t\t\t\t\t\t\t} catch (error) {\n\t\t\t\t\t\t\t\tarchiveSymlinkViolation = error instanceof Error ? error : new Error(String(error));\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\tentry.path = archiveEntryPath;\n\t\t\t\t\t\t}\n\t\t\t\t\t}, [\n\t\t\t\t\t\tmanifestPath,\n\t\t\t\t\t\t...stateSqliteBackup.snapshots.map((snapshot) => snapshot.sourcePath),\n\t\t\t\t\t\t...legacyAuditSnapshots.map((snapshot) => snapshot.sourcePath),\n\t\t\t\t\t\t...result.assets.map((asset) => asset.sourcePath)\n\t\t\t\t\t]),\n\t\t\t\t\tonPartialArchive: (partialArchive) => {\n\t\t\t\t\t\tpublication.pendingCleanupArchives.push(partialArchive);\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t\tconst unexpectedSqliteSourcePath = unexpectedSqliteSourcePaths[0];\n\t\t\t\tconst archiveValidationError = unexpectedSqliteSourcePath ? /* @__PURE__ */ new Error(`SQLite state appeared after snapshot discovery: ${unexpectedSqliteSourcePath}. Retry backup so it can be snapshotted.`) : archiveSymlinkViolation;\n\t\t\t\tif (archiveValidationError) {\n\t\t\t\t\tif (!removePreparedBackupArchive(prepared)) publication.pendingCleanupArchives.push(prepared);\n\t\t\t\t\tthrow archiveValidationError;\n\t\t\t\t}\n\t\t\t\treturn prepared;\n\t\t\t}\n\t\t}).catch((error) => {\n\t\t\tthrow formatBackupOutputFailure(error, outputPath, \"write\", publication.stagingDir);\n\t\t});\n\t\tresult.skippedVolatileCount = skippedVolatileCount;\n\t\tif (skippedVolatileCount > 0) opts.log?.(`Backup skipped ${skippedVolatileCount} volatile file${skippedVolatileCount === 1 ? \"\" : \"s\"} (live sessions, cron logs, queues, managed runtime paths, sockets, pid/tmp).`);\n\t\ttry {\n\t\t\tawait publishPreparedBackupArchive({\n\t\t\t\tplan: publication,\n\t\t\t\tprepared: completedArchive,\n\t\t\t\tlog: opts.log\n\t\t\t});\n\t\t} catch (error) {\n\t\t\tthrow formatBackupOutputFailure(error, outputPath, \"publication\");\n\t\t}\n\t} finally {\n\t\tawait cleanupBackupArchivePublication(publication, opts.log);\n\t\tawait fs$1.rm(tempDir, {\n\t\t\trecursive: true,\n\t\t\tforce: true\n\t\t}).catch(() => void 0);\n\t}\n\treturn result;\n}"
  },
  {
    "role": "backup-verify-B70_GdSp.js",
    "name": "verifySqliteSnapshots",
    "body": "async function verifySqliteSnapshots(params) {\n\tconst sqliteEntries = listSqliteSnapshotEntries(params.manifest, params.entries);\n\tif (sqliteEntries.length === 0) return;\n\tfor (const entry of sqliteEntries) if (!isRegularArchiveFile(entry.type)) throw new Error(`SQLite snapshot must be a regular archive file: ${entry.normalized}`);\n\tconst tempRoot = os.tmpdir();\n\tassertSqliteExtractionBudget({\n\t\tentries: sqliteEntries,\n\t\ttempRoot\n\t});\n\tconst tempDir = await fs.mkdtemp(path.join(tempRoot, \"openclaw-backup-verify-sqlite-\"));\n\ttry {\n\t\tconst sqliteEntriesByRawPath = new Map(sqliteEntries.map((entry) => [entry.raw, entry]));\n\t\tawait tar.x({\n\t\t\tfile: params.archivePath,\n\t\t\tgzip: true,\n\t\t\tmaxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,\n\t\t\tcwd: tempDir,\n\t\t\tstrict: true,\n\t\t\tpreserveOwner: false,\n\t\t\tfilter: (entryPath, archiveEntry) => {\n\t\t\t\tconst expected = sqliteEntriesByRawPath.get(entryPath);\n\t\t\t\tif (!expected) return false;\n\t\t\t\tif (archiveEntry.size !== expected.size) throw new Error(`SQLite snapshot size changed during verification: ${entryPath}`);\n\t\t\t\treturn true;\n\t\t\t}\n\t\t});\n\t\tfor (const entry of sqliteEntries) {\n\t\t\tconst extractedPath = path.join(tempDir, ...entry.normalized.split(\"/\"));\n\t\t\tconst extractedStat = await fs.lstat(extractedPath);\n\t\t\tif (!extractedStat.isFile()) throw new Error(`Extracted SQLite snapshot is not a regular file: ${entry.normalized}`);\n\t\t\tif (extractedStat.size !== entry.size) throw new Error(`Extracted SQLite snapshot size does not match archive: ${entry.normalized}`);\n\t\t\tlet database;\n\t\t\ttry {\n\t\t\t\tawait assertSqliteSnapshotFileShape(extractedPath, entry.normalized, extractedStat.size);\n\t\t\t\tconst expectedRole = resolveExpectedSqliteRole(entry);\n\t\t\t\tif (!expectedRole) continue;\n\t\t\t\tdatabase = openNodeSqliteDatabase(extractedPath, {\n\t\t\t\t\tallowExtension: true,\n\t\t\t\t\treadOnly: true\n\t\t\t\t});\n\t\t\t\tdatabase.exec(\"PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;\");\n\t\t\t\tawait loadSqliteVecExtension({ db: database });\n\t\t\t\tassertSqliteIntegrity(database, entry.normalized);\n\t\t\t\tif (entry.agentId) assertOpenClawAgentDatabaseOwner(database, {\n\t\t\t\t\tagentId: entry.agentId,\n\t\t\t\t\tpathname: entry.normalized\n\t\t\t\t});\n\t\t\t\telse assertExpectedSqliteRole(database, entry.normalized, expectedRole);\n\t\t\t} catch (err) {\n\t\t\t\tconst message = err instanceof Error ? err.message : String(err);\n\t\t\t\tthrow new Error(`Backup SQLite snapshot failed verification: ${entry.normalized}. ${message}`, { cause: err });\n\t\t\t} finally {\n\t\t\t\tdatabase?.close();\n\t\t\t}\n\t\t}\n\t} finally {\n\t\tawait fs.rm(tempDir, {\n\t\t\trecursive: true,\n\t\t\tforce: true\n\t\t});\n\t}\n}"
  },
  {
    "role": "worker/worker.mjs",
    "name": "buildBackupArchiveRoot",
    "body": "function buildBackupArchiveRoot(Ot=Date.now()){return`${formatBackupArchiveTimestamp(Ot)}-openclaw-backup`}"
  },
  {
    "role": "worker/worker.mjs",
    "name": "createBackupArchivePublication",
    "body": "async function createBackupArchivePublication(Ot){let Zt=path.resolve(Ot),_n=path.dirname(Zt),Dn=await fs$1.realpath(_n),kn=await fs$1.lstat(Dn);if(!kn.isDirectory())throw Error(`Backup output parent is not a directory: ${_n}`);let Pn=path.join(Dn,path.basename(Zt));await assertTargetAbsent$1(Pn);let Fn=await fs$1.mkdtemp(path.join(Dn,`.openclaw-backup-publish-${randomUUID()}-`)),Ln;try{return Ln=await fs$1.lstat(Fn),await fs$1.chmod(Fn,448),{canonicalOutputPath:Pn,canonicalParentPath:Dn,parentReceipt:{path:Dn,realPath:Dn,identity:kn},pendingCleanupArchives:[],requestedOutputPath:Zt,requestedParentPath:_n,stagingDir:Fn,stagingIdentity:Ln,tempArchivePath:path.join(Fn,`archive.tar.gz.tmp`)}}catch(Ot){throw Ln&&await removeDirectoryIfOwned(Fn,Ln),Ot}}"
  },
  {
    "role": "worker/worker.mjs",
    "name": "createBackupArchive",
    "body": "async function createBackupArchive(Ot={}){let Zt=resolveDateTimestampMs(Ot.nowMs),_n=buildBackupArchiveRoot(Zt),Dn=!!Ot.onlyConfig,kn=Dn?!1:Ot.includeWorkspace??!0,Pn=await resolveBackupPlanFromDisk({includeWorkspace:kn,onlyConfig:Dn,nowMs:Zt}),Fn=await resolveOutputPath({output:Ot.output,nowMs:Zt,includedAssets:Pn.included,stateDir:Pn.stateDir});if(Pn.included.length===0)throw Error(Dn?`No Uniopc config file was found to back up.`:`No local Uniopc state was found to back up.`);let Ln=await canonicalizePathForContainment(Fn),Jn=Pn.included.find(Ot=>isPathWithin$1(Ln,Ot.sourcePath));if(Jn)throw Error(`Backup output must not be written inside a source path: ${Fn} is inside ${Jn.sourcePath}`);Ot.dryRun||await assertOutputPathReady(Fn);let cr=new Date(Zt).toISOString(),pr=Pn.included.find(Ot=>Ot.kind===`state`),xr={createdAt:cr,archiveRoot:_n,archivePath:Fn,dryRun:!!Ot.dryRun,includeWorkspace:kn,onlyConfig:Dn,verified:!1,assets:Pn.included,...Dn?{}:{agentRoots:Pn.inventory.agentRoots.map(({agentId:Ot,sourcePath:Zt})=>({agentId:Ot,sourcePath:Zt}))},skipped:Pn.skipped,skippedVolatileCount:0};if(Ot.dryRun)return xr;await prepareBackupOutputParent(Fn);let Mr=await chooseBackupTempRoot({assets:xr.assets,outputPath:Fn});await fs$1.mkdir(Mr,{recursive:!0});let Pr=await fs$1.mkdtemp(path.join(Mr,`openclaw-backup-`)),Br=path.join(Pr,`manifest.json`),Hr;try{Hr=await createBackupArchivePublication(Fn)}catch(Ot){throw await fs$1.rm(Pr,{recursive:!0,force:!0}).catch(()=>void 0),formatBackupOutputFailure(Ot,Fn,`publication`)}let mi=Hr.tempArchivePath;try{let Zt=pr?await hasLegacyAuditBackupSources(pr.sourcePath):!1,createSnapshotPlans=async()=>{let Ot=pr&&Zt?await createLegacyAuditBackupSnapshots({stateDir:pr.sourcePath,tempDir:Pr}):[];return{legacyAuditSnapshots:Ot,stateSqliteBackup:Dn?{snapshots:[],discoveredSourcePaths:new Set}:await createBackupSqliteSnapshotPlan({inventory:Pn.inventory,tempDir:Pr,legacyAuditSnapshots:Ot})}},{legacyAuditSnapshots:Ln,stateSqliteBackup:Jn}=pr&&Zt?await withLegacyAuditMigrationLease(pr.sourcePath,createSnapshotPlans):await createSnapshotPlans(),Mr=new Map,Si=new Set;for(let Ot of Jn.snapshots){Mr.set(path.resolve(Ot.sourcePath),Ot.archiveSourcePath);for(let Zt of Ot.skippedSourcePaths)Si.add(Zt)}for(let Ot of Ln){Mr.set(path.resolve(Ot.sourcePath),Ot.archiveSourcePath);for(let Zt of Ot.skippedSourcePaths)Si.add(Zt)}let wi=buildManifest({createdAt:cr,archiveRoot:_n,includeWorkspace:kn,onlyConfig:Dn,assets:xr.assets,skipped:xr.skipped,stateDir:Pn.stateDir,configPath:Pn.configPath,oauthDir:Pn.oauthDir,workspaceDirs:Pn.workspaceDirs,agentRoots:Pn.inventory.agentRoots});await writeJson$1(Br,wi,{trailingNewline:!0});let Di=await loadTarRuntime(),Mi=resolveGatewayLockDir(Pn.stateDir),ea={stateDirs:[pr?.sourcePath??Pn.stateDir]},ta=0,na=[],ra,tarFilter=(Ot,Zt)=>{let _n=path.resolve(Ot);if(_n===Br)return!0;let kn=`isDirectory`in Zt?Zt.isDirectory():Zt.type===`Directory`;if(!Dn&&!(kn?Pn.inventory.isTraversable(_n):Pn.inventory.isIncluded(_n))||isPathWithin$1(_n,Mi)||pr&&isLegacyAuditMigrationBackupPath(_n,pr.sourcePath))return!1;let Fn=Dn?void 0:classifyBackupSqliteSource(_n,Pn.inventory);return Fn===`excluded`||Si.has(_n)||Fn===`sqlite`&&Jn.discoveredSourcePaths.has(_n)?!1:Fn===`sqlite`&&isBackupTarFilterFile(Zt)?(na.push(Ot),!1):isVolatileBackupPath(Ot,ea)?(ta+=1,!1):!0},ia=await writeTarArchiveWithRetry({tempArchivePath:mi,log:Ot.log,runTar:async Ot=>{ta=0,na.length=0,ra=void 0;let Zt=await writeArchiveStreamToFile({archivePath:Ot,createArchiveStream:Ot=>Di.c({gzip:!0,portable:!0,preservePaths:!0,linkCache:createBackupLinkCache(),statCache:createBackupVolatileStatCache(ea),filter:(Zt,_n)=>(Ot({phase:`traversal`,entryPath:Zt}),tarFilter(Zt,_n)),onWriteEntry:Zt=>{let Dn=Zt.path;Ot({phase:`entry`,entryPath:Dn}),Zt.type===`File`&&(Zt.stat?.size??0)>0&&observeBackupTarEntryProgress(Zt,Zt=>{Ot({phase:`raw`,entryPath:Dn,bytes:Zt})});let kn=remapArchiveEntryPath({entryPath:Zt.path,manifestPath:Br,archiveRoot:_n,sourcePathRemaps:Mr});if(Zt.type===`SymbolicLink`&&!ra)try{assertArchiveSymbolicLinkTarget({archiveRoot:_n,entryPath:kn,linkpath:Zt.linkpath,assetArchivePaths:wi.assets.map(Ot=>Ot.archivePath)})}catch(Ot){ra=Ot instanceof Error?Ot:Error(String(Ot))}Zt.path=kn}},[Br,...Jn.snapshots.map(Ot=>Ot.sourcePath),...Ln.map(Ot=>Ot.sourcePath),...xr.assets.map(Ot=>Ot.sourcePath)]),onPartialArchive:Ot=>{Hr.pendingCleanupArchives.push(Ot)}}),Dn=na[0],kn=Dn?Error(`SQLite state appeared after snapshot discovery: ${Dn}. Retry backup so it can be snapshotted.`):ra;if(kn)throw removePreparedBackupArchive(Zt)||Hr.pendingCleanupArchives.push(Zt),kn;return Zt}}).catch(Ot=>{throw formatBackupOutputFailure(Ot,Fn,`write`,Hr.stagingDir)});xr.skippedVolatileCount=ta,ta>0&&Ot.log?.(`Backup skipped ${ta} volatile file${ta===1?``:`s`} (live sessions, cron logs, queues, managed runtime paths, sockets, pid/tmp).`);try{await publishPreparedBackupArchive({plan:Hr,prepared:ia,log:Ot.log})}catch(Ot){throw formatBackupOutputFailure(Ot,Fn,`publication`)}}finally{await cleanupBackupArchivePublication(Hr,Ot.log),await fs$1.rm(Pr,{recursive:!0,force:!0}).catch(()=>void 0)}return xr}"
  },
  {
    "role": "worker/worker.mjs",
    "name": "verifySqliteSnapshots",
    "body": "async function verifySqliteSnapshots(Ot){let Zt=listSqliteSnapshotEntries(Ot.manifest,Ot.entries);if(Zt.length===0)return;for(let Ot of Zt)if(!isRegularArchiveFile(Ot.type))throw Error(`SQLite snapshot must be a regular archive file: ${Ot.normalized}`);let _n=os.tmpdir();assertSqliteExtractionBudget({entries:Zt,tempRoot:_n});let Dn=await fs$1.mkdtemp(path.join(_n,`openclaw-backup-verify-sqlite-`));try{let _n=new Map(Zt.map(Ot=>[Ot.raw,Ot]));await So({file:Ot.archivePath,gzip:!0,maxDecompressionRatio:BACKUP_MAX_DECOMPRESSION_RATIO,cwd:Dn,strict:!0,preserveOwner:!1,filter:(Ot,Zt)=>{let Dn=_n.get(Ot);if(!Dn)return!1;if(Zt.size!==Dn.size)throw Error(`SQLite snapshot size changed during verification: ${Ot}`);return!0}});for(let Ot of Zt){let Zt=path.join(Dn,...Ot.normalized.split(`/`)),_n=await fs$1.lstat(Zt);if(!_n.isFile())throw Error(`Extracted SQLite snapshot is not a regular file: ${Ot.normalized}`);if(_n.size!==Ot.size)throw Error(`Extracted SQLite snapshot size does not match archive: ${Ot.normalized}`);let kn;try{await assertSqliteSnapshotFileShape(Zt,Ot.normalized,_n.size);let Dn=resolveExpectedSqliteRole(Ot);if(!Dn)continue;kn=openNodeSqliteDatabase(Zt,{allowExtension:!0,readOnly:!0}),kn.exec(`PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;`),await loadSqliteVecExtension({db:kn}),assertSqliteIntegrity(kn,Ot.normalized),Ot.agentId?assertOpenClawAgentDatabaseOwner(kn,{agentId:Ot.agentId,pathname:Ot.normalized}):assertExpectedSqliteRole(kn,Ot.normalized,Dn)}catch(Zt){let _n=Zt instanceof Error?Zt.message:String(Zt);throw Error(`Backup SQLite snapshot failed verification: ${Ot.normalized}. ${_n}`,{cause:Zt})}finally{kn?.close()}}}finally{await fs$1.rm(Dn,{recursive:!0,force:!0})}}"
  },
  {
    "role": "register.backup-BFONF7_5.js",
    "name": "registerBackupCommand",
    "body": "function registerBackupCommand(program) {\n\tconst backup = program.command(\"backup\").description(\"Create, verify, and restore backup archives and SQLite snapshots\").addHelpText(\"after\", () => `\\n${theme.muted(\"Docs:\")} ${formatDocsLink(\"/cli/backup\", \"docs.openclaw.ai/cli/backup\")}\\n`);\n\tbackup.command(\"create\").description(\"Write a backup archive for config, credentials, sessions, and workspaces\").option(\"--output <path>\", \"Archive path or destination directory\").option(\"--json\", \"Output JSON\", false).option(\"--dry-run\", \"Print the backup plan without writing the archive\", false).option(\"--verify\", \"Verify the archive after writing it\", false).option(\"--only-config\", \"Back up only the active JSON config file\", false).option(\"--no-include-workspace\", \"Exclude workspace directories from the backup\").addHelpText(\"after\", () => `\\n${theme.heading(\"Examples:\")}\\n${formatHelpExamples([\n\t\t[\"openclaw backup create\", \"Create a timestamped backup in the current directory.\"],\n\t\t[\"openclaw backup create --output ~/Backups\", \"Write the archive into an existing backup directory.\"],\n\t\t[\"openclaw backup create --dry-run --json\", \"Preview the archive plan without writing any files.\"],\n\t\t[\"openclaw backup create --verify\", \"Create the archive and immediately validate its manifest and payload layout.\"],\n\t\t[\"openclaw backup create --no-include-workspace\", \"Back up state/config without agent workspace files.\"],\n\t\t[\"openclaw backup create --only-config\", \"Back up only the active JSON config file.\"]\n\t])}`).action(async (opts) => {\n\t\tawait runCommandWithRuntime(defaultRuntime, async () => {\n\t\t\tawait backupCreateCommand(defaultRuntime, {\n\t\t\t\toutput: opts.output,\n\t\t\t\tjson: Boolean(opts.json),\n\t\t\t\tdryRun: Boolean(opts.dryRun),\n\t\t\t\tverify: Boolean(opts.verify),\n\t\t\t\tonlyConfig: Boolean(opts.onlyConfig),\n\t\t\t\tincludeWorkspace: opts.includeWorkspace\n\t\t\t});\n\t\t});\n\t});\n\tbackup.command(\"verify <archive>\").description(\"Validate a backup archive and its embedded manifest\").option(\"--json\", \"Output JSON\", false).addHelpText(\"after\", () => `\\n${theme.heading(\"Examples:\")}\\n${formatHelpExamples([[\"openclaw backup verify ./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz\", \"Check that the archive structure and manifest are intact.\"], [\"openclaw backup verify ~/Backups/latest.tar.gz --json\", \"Emit machine-readable verification output.\"]])}`).action(async (archive, opts) => {\n\t\tawait runCommandWithRuntime(defaultRuntime, async () => {\n\t\t\tawait backupVerifyCommand(defaultRuntime, {\n\t\t\t\tarchive,\n\t\t\t\tjson: Boolean(opts.json)\n\t\t\t});\n\t\t});\n\t});\n\tbackup.command(\"restore <archive>\").description(\"Restore a verified backup archive to a fresh staging directory\").requiredOption(\"--target <dir>\", \"Fresh target directory; non-empty directories are refused\").option(\"--json\", \"Output JSON\", false).addHelpText(\"after\", () => `\\n${theme.heading(\"Examples:\")}\\n${formatHelpExamples([[\"openclaw backup restore ~/Backups/latest.tar.gz --target ./restored-openclaw\", \"Verify, then extract the whole archive into a fresh staging directory.\"], [\"openclaw backup restore ~/Backups/latest.tar.gz --target ./restored-openclaw --json\", \"Emit machine-readable restore details and rollback warnings.\"]])}`).action(async (archive, opts) => {\n\t\tawait runCommandWithRuntime(defaultRuntime, async () => {\n\t\t\tawait backupRestoreCommand(defaultRuntime, {\n\t\t\t\tarchive,\n\t\t\t\ttarget: opts.target,\n\t\t\t\tjson: Boolean(opts.json)\n\t\t\t});\n\t\t});\n\t});\n\tregisterBackupSqliteCommands(backup);\n\tregisterBackupGitCommands(backup);\n\tregisterBackupScheduleCommands(backup);\n}"
  },
  {
    "role": "backup-archive-path-policy-DKQb_csh.js",
    "name": "createBackupResourceInventory",
    "body": "async function createBackupResourceInventory(params) {\n\tconst stateDir = path.resolve(params.stateDir);\n\tconst agentRoots = Object.freeze(params.agentRoots.map((root) => Object.freeze({\n\t\tagentId: root.agentId,\n\t\tsourcePath: path.resolve(root.sourcePath),\n\t\tdatabasePath: path.resolve(root.databasePath)\n\t})));\n\tconst protectedPathSet = /* @__PURE__ */ new Set([path.resolve(params.configPath), resolveOpenClawStateSqlitePath({\n\t\t...process.env,\n\t\tOPENCLAW_STATE_DIR: stateDir\n\t})]);\n\tconst regenerableRoots = [];\n\tconst exclude = (kind, sourcePath) => {\n\t\tregenerableRoots.push({\n\t\t\tkind,\n\t\t\tsourcePath: path.resolve(sourcePath)\n\t\t});\n\t};\n\tif (!params.onlyConfig) {\n\t\tprotectedPathSet.add(path.resolve(params.oauthDir));\n\t\tfor (const workspaceDir of params.workspaceDirs) protectedPathSet.add(path.resolve(workspaceDir));\n\t\tfor (const root of agentRoots) {\n\t\t\tprotectedPathSet.add(root.sourcePath);\n\t\t\tprotectedPathSet.add(root.databasePath);\n\t\t}\n\t\tfor (const root of MANAGED_STATE_ROOTS) exclude(\"managed state\", path.join(stateDir, root));\n\t\tfor (const temporaryRoot of await listDefaultAgentTemporaryRoots(stateDir, agentRoots)) exclude(\"agent temporary files\", temporaryRoot);\n\t\texclude(\"plugin skills\", path.join(stateDir, \"plugin-skills\"));\n\t\tfor (const resource of params.pluginResources) {\n\t\t\tconst anchors = resource.scope === \"state\" ? [{ sourcePath: stateDir }] : agentRoots;\n\t\t\tfor (const anchor of anchors) {\n\t\t\t\tconst sourcePath = path.resolve(anchor.sourcePath, ...resource.relativePath.split(\"/\"));\n\t\t\t\tif (!isPathWithin(sourcePath, anchor.sourcePath)) throw new Error(`Plugin ${resource.pluginId} backup resource escapes its ${resource.scope} root: ${resource.relativePath}`);\n\t\t\t\tif (resource.disposition === \"include\") protectedPathSet.add(sourcePath);\n\t\t\t\telse exclude(\"plugin resource\", sourcePath);\n\t\t\t}\n\t\t}\n\t\tfor (const pluginRoot of params.pluginRoots) exclude(\"plugin dependencies\", path.join(pluginRoot, \"node_modules\"));\n\t}\n\tconst seenRegenerableRoots = /* @__PURE__ */ new Set();\n\tconst uniqueRegenerableRoots = Object.freeze(regenerableRoots.toSorted((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.kind.localeCompare(right.kind)).filter((resource) => {\n\t\tconst key = `${resource.kind}\\0${resource.sourcePath}`;\n\t\tif (seenRegenerableRoots.has(key)) return false;\n\t\tseenRegenerableRoots.add(key);\n\t\treturn true;\n\t}));\n\tconst protectedPaths = Object.freeze([...protectedPathSet].toSorted());\n\tconst excludedPaths = Object.freeze(uniqueRegenerableRoots.map((resource) => resource.sourcePath).toSorted((left, right) => right.length - left.length || left.localeCompare(right)));\n\tconst isIncluded = (sourcePath) => {\n\t\tconst candidate = path.resolve(sourcePath);\n\t\tconst exclusion = excludedPaths.find((excludedPath) => isPathWithin(candidate, excludedPath));\n\t\tif (!exclusion) return true;\n\t\treturn protectedPaths.some((protectedPath) => isPathWithin(candidate, protectedPath) && isPathWithin(protectedPath, exclusion));\n\t};\n\tconst isTraversable = (sourcePath) => {\n\t\tconst candidate = path.resolve(sourcePath);\n\t\treturn isIncluded(candidate) || protectedPaths.some((protectedPath) => isPathWithin(protectedPath, candidate));\n\t};\n\tconst isPackageContent = (sourcePath) => {\n\t\tconst candidate = path.resolve(sourcePath);\n\t\tif (protectedPaths.some((protectedPath) => isPathWithin(candidate, protectedPath) || isPathWithin(protectedPath, candidate))) return false;\n\t\tif (!isPathWithin(candidate, stateDir)) return false;\n\t\tconst segments = path.relative(stateDir, candidate).split(path.sep);\n\t\tif (segments[0] === \"agents\" && segments[1] && (segments.length === 2 || segments[2] === \"agent\" && (segments.length === 3 || segments.length === 4 && /^openclaw-agent\\.sqlite(?:-wal|-shm|-journal)?$/u.test(segments[3] ?? \"\")))) return false;\n\t\treturn segments.includes(\"node_modules\");\n\t};\n\treturn Object.freeze({\n\t\tstateDir,\n\t\tagentRoots,\n\t\tregenerableRoots: uniqueRegenerableRoots,\n\t\tisIncluded,\n\t\tisTraversable,\n\t\tisPackageContent\n\t});\n}"
  },
  {
    "role": "worker/worker.mjs",
    "name": "createBackupResourceInventory",
    "body": "async function createBackupResourceInventory(Ot){let Zt=path.resolve(Ot.stateDir),_n=Object.freeze(Ot.agentRoots.map(Ot=>Object.freeze({agentId:Ot.agentId,sourcePath:path.resolve(Ot.sourcePath),databasePath:path.resolve(Ot.databasePath)}))),Dn=new Set([path.resolve(Ot.configPath),resolveOpenClawStateSqlitePath({...process.env,OPENCLAW_STATE_DIR:Zt})]),kn=[],exclude=(Ot,Zt)=>{kn.push({kind:Ot,sourcePath:path.resolve(Zt)})};if(!Ot.onlyConfig){Dn.add(path.resolve(Ot.oauthDir));for(let Zt of Ot.workspaceDirs)Dn.add(path.resolve(Zt));for(let Ot of _n)Dn.add(Ot.sourcePath),Dn.add(Ot.databasePath);for(let Ot of MANAGED_STATE_ROOTS)exclude(`managed state`,path.join(Zt,Ot));for(let Ot of await listDefaultAgentTemporaryRoots(Zt,_n))exclude(`agent temporary files`,Ot);exclude(`plugin skills`,path.join(Zt,`plugin-skills`));for(let kn of Ot.pluginResources){let Ot=kn.scope===`state`?[{sourcePath:Zt}]:_n;for(let Zt of Ot){let Ot=path.resolve(Zt.sourcePath,...kn.relativePath.split(`/`));if(!isPathWithin$1(Ot,Zt.sourcePath))throw Error(`Plugin ${kn.pluginId} backup resource escapes its ${kn.scope} root: ${kn.relativePath}`);kn.disposition===`include`?Dn.add(Ot):exclude(`plugin resource`,Ot)}}for(let Zt of Ot.pluginRoots)exclude(`plugin dependencies`,path.join(Zt,`node_modules`))}let Pn=new Set,Fn=Object.freeze(kn.toSorted((Ot,Zt)=>Ot.sourcePath.localeCompare(Zt.sourcePath)||Ot.kind.localeCompare(Zt.kind)).filter(Ot=>{let Zt=`${Ot.kind}\\0${Ot.sourcePath}`;return Pn.has(Zt)?!1:(Pn.add(Zt),!0)})),Ln=Object.freeze([...Dn].toSorted()),Jn=Object.freeze(Fn.map(Ot=>Ot.sourcePath).toSorted((Ot,Zt)=>Zt.length-Ot.length||Ot.localeCompare(Zt))),isIncluded=Ot=>{let Zt=path.resolve(Ot),_n=Jn.find(Ot=>isPathWithin$1(Zt,Ot));return!_n||Ln.some(Ot=>isPathWithin$1(Zt,Ot)&&isPathWithin$1(Ot,_n))};return Object.freeze({stateDir:Zt,agentRoots:_n,regenerableRoots:Fn,isIncluded,isTraversable:Ot=>{let Zt=path.resolve(Ot);return isIncluded(Zt)||Ln.some(Ot=>isPathWithin$1(Ot,Zt))},isPackageContent:Ot=>{let _n=path.resolve(Ot);if(Ln.some(Ot=>isPathWithin$1(_n,Ot)||isPathWithin$1(Ot,_n))||!isPathWithin$1(_n,Zt))return!1;let Dn=path.relative(Zt,_n).split(path.sep);return Dn[0]===`agents`&&Dn[1]&&(Dn.length===2||Dn[2]===`agent`&&(Dn.length===3||Dn.length===4&&/^openclaw-agent\\.sqlite(?:-wal|-shm|-journal)?$/u.test(Dn[3]??``)))?!1:Dn.includes(`node_modules`)}})}"
  }
]
export const BACKUP_OUTPUT_ANCHORS = [
  {
    "role": "backup-archive-path-policy-DKQb_csh.js",
    "anchor": "function buildBackupArchiveRoot(nowMs = Date.now()) {\n\treturn `${formatBackupArchiveTimestamp(nowMs)}-openclaw-backup`;\n}"
  },
  {
    "role": "backup-AYb2BIZo.js",
    "anchor": "await fs$1.mkdtemp(path.join(canonicalParentPath, `.openclaw-backup-publish-${randomUUID()}-`))"
  },
  {
    "role": "backup-AYb2BIZo.js",
    "anchor": "await fs$1.mkdtemp(path.join(tempRoot, \"openclaw-backup-\"))"
  },
  {
    "role": "backup-verify-B70_GdSp.js",
    "anchor": "await fs.mkdtemp(path.join(tempRoot, \"openclaw-backup-verify-sqlite-\"))"
  },
  {
    "role": "worker/worker.mjs",
    "anchor": "function buildBackupArchiveRoot(Ot=Date.now()){return`${formatBackupArchiveTimestamp(Ot)}-openclaw-backup`}"
  },
  {
    "role": "worker/worker.mjs",
    "anchor": "await fs$1.mkdtemp(path.join(Dn,`.openclaw-backup-publish-${randomUUID()}-`))"
  },
  {
    "role": "worker/worker.mjs",
    "anchor": "await fs$1.mkdtemp(path.join(Mr,`openclaw-backup-`))"
  },
  {
    "role": "worker/worker.mjs",
    "anchor": "await fs$1.mkdtemp(path.join(_n,`openclaw-backup-verify-sqlite-`))"
  },
  {
    "role": "register.backup-BFONF7_5.js",
    "anchor": "openclaw backup verify ./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz"
  }
]
export const ESCAPED_DATABASE_ANCHORS = [
  {
    "role": "backup-archive-path-policy-DKQb_csh.js",
    "anchor": "/^openclaw-agent\\.sqlite(?:-wal|-shm|-journal)?$/u"
  },
  {
    "role": "worker/worker.mjs",
    "anchor": "/^openclaw-agent\\.sqlite(?:-wal|-shm|-journal)?$/u"
  }
]
const GENERATED_DATABASE_NAMES = ['openclaw-agent.sqlite', 'incognito-openclaw-agent.sqlite', 'openclaw.sqlite']
const brandedGeneratedName = value => value.replaceAll('openclaw', 'uniopc')
function generatedRolePath(path, role) {
  const normalized = path.replaceAll('\\', '/').replaceAll('openclaw-', 'uniopc-')
  return normalized.endsWith('/dist/' + role)
}
function databaseCounts(source, branded) {
  const names = branded ? GENERATED_DATABASE_NAMES.map(brandedGeneratedName) : GENERATED_DATABASE_NAMES
  const counts = names.map(name => source.split(name).length - 1)
  counts[0] -= counts[1] // The incognito basename contains the ordinary basename.
  return counts
}
function patchGeneratedState(source) {
  for (const {anchor} of BACKUP_OUTPUT_ANCHORS) source = source.replace(anchor, anchor.replaceAll('openclaw-backup','uniopc-backup'))
  for (const {anchor} of ESCAPED_DATABASE_ANCHORS) source = source.replace(anchor, anchor.replace('openclaw-agent','uniopc-agent'))
  for (const name of [...GENERATED_DATABASE_NAMES].sort((a,b) => b.length-a.length)) source = source.replaceAll(name, brandedGeneratedName(name))
  // Only these exact default expressions change. Other worker labels retain
  // their upstream technical identities, and caller-supplied stores are intact.
  source = source.replace('path.basename(resolved, path.extname(resolved)) || "openclaw-agent"', 'path.basename(resolved, path.extname(resolved)) || "uniopc-agent"')
    .replace('path.basename(Zt,path.extname(Zt))||`openclaw-agent`', 'path.basename(Zt,path.extname(Zt))||`uniopc-agent`')
    .replace('tempPrefix: "openclaw-agent-cli"', 'tempPrefix: "uniopc-agent-cli"')
    .replace('tempPrefix:`openclaw-agent-cli`', 'tempPrefix:`uniopc-agent-cli`')
    .replace('return [path.join(packageRoot, "openclaw.mjs")];', 'return [path.join(packageRoot, "uniopc-engine.mjs")];')
    .replace('return[path.join(Ot,`openclaw.mjs`)]', 'return[path.join(Ot,`uniopc-engine.mjs`)]')
    .replace('OPENCLAW_CLI_ENTRY_BASENAMES = /* @__PURE__ */ new Set(["openclaw", "openclaw.mjs"])', 'OPENCLAW_CLI_ENTRY_BASENAMES = /* @__PURE__ */ new Set(["openclaw", "openclaw.mjs", "uniopc-engine", "uniopc-engine.mjs"])')
    .replace('OPENCLAW_CLI_ENTRY_BASENAMES=new Set([`openclaw`,`openclaw.mjs`])', 'OPENCLAW_CLI_ENTRY_BASENAMES=new Set([`openclaw`,`openclaw.mjs`,`uniopc-engine`,`uniopc-engine.mjs`])')
  return source
}
// Prove all pinned ranges in one parse group per source. Exporting the bindings
// proves they are top-level; removing their exact declarations and declaring
// constants proves the bindings came from those executable ranges. No source is
// linked or evaluated, and worker-sized modules need only three parses.
function verifyGeneratedTopLevelRanges(source, ranges, label) {
  const parser = `import {SourceTextModule} from 'node:vm';
import {readFileSync} from 'node:fs';
try {
  const {source,ranges}=JSON.parse(readFileSync(0,'utf8'));
  new SourceTextModule(source);
  new SourceTextModule(source+'\\nexport {'+ranges.map((r,i)=>r.name+' as __uniopc_contract_'+i).join(',')+'};');
  let removed=source;
  for(const range of [...ranges].sort((a,b)=>b.start-a.start)) removed=removed.slice(0,range.start)+removed.slice(range.end);
  new SourceTextModule(removed+'\\n'+ranges.map(r=>'const '+r.name+'=0;').join('\\n'));
} catch {process.stderr.write('Generated state top-level contract failed\\n');process.exitCode=1;}`
  const env={...process.env}
  for(const key of Object.keys(env)) if(['NODE_OPTIONS','NODE_PATH'].includes(key.toUpperCase())) delete env[key]
  try {
    execFileSync(process.execPath,['--experimental-vm-modules','--no-warnings','--input-type=module','-e',parser],
      {input:JSON.stringify({source,ranges}),encoding:'utf8',env,stdio:['pipe','pipe','pipe'],timeout:60000,maxBuffer:65536})
  } catch {assert.fail(`Generated state ${label} top-level uniqueness structure drift`)}
}

export function inspectGeneratedStateSources(sources, {allowUnpatched = false} = {}) {
  const patches = new Map()
  const covered = new Set()
  const states = new Map()
  const topLevelRanges = new Map()
  function recordState(path, branded, original) {
    if (branded && original) return // An unchanged function contributes no state.
    const state = branded ? 'branded' : 'original'
    assert.ok(!states.has(path) || states.get(path) === state, `Generated state partial role conversion: ${path}`)
    states.set(path, state)
  }
  for (const {role, counts} of GENERATED_STATE_ROLES) {
    const entries = sources.filter(entry => generatedRolePath(entry.path, role))
    assert.equal(entries.length, 1, `Generated state requires exactly one ${role} role`)
    const entry = entries[0]
    covered.add(entry.path)
    const oldCounts = databaseCounts(entry.source, false)
    const newCounts = databaseCounts(entry.source, true)
    const original = oldCounts.every((count,index) => count === counts[index]) && newCounts.every(count => count === 0)
    const branded = newCounts.every((count,index) => count === counts[index]) && oldCounts.every(count => count === 0)
    assert.ok(branded || (allowUnpatched && original), `Generated state ${role} basename count/partial conversion drift`)
    recordState(entry.path, branded, original)
  }
  for (const entry of sources) {
    if (!covered.has(entry.path)) assert.ok([...databaseCounts(entry.source,false), ...databaseCounts(entry.source,true)].every(count => count === 0),
      `Generated state unknown basename role: ${entry.path}`)
  }
  for (const contract of GENERATED_STATE_FUNCTIONS) {
    const entries = sources.filter(entry => generatedRolePath(entry.path,contract.role))
    assert.equal(entries.length,1, `Generated state requires exactly one ${contract.role} function role`)
    const entry=entries[0]
    const totalDeclarations=sources.reduce((count,item)=>count+[...item.source.matchAll(new RegExp(String.raw`\bfunction${nativeTrivia}\*?${nativeTrivia}${contract.name}${nativeTrivia}\(`,'g'))].length,0)
    assert.equal(totalDeclarations, GENERATED_STATE_FUNCTIONS.filter(item=>item.name===contract.name).length, `Generated state ${contract.name} extra declaration drift`)
    const declarations=[...entry.source.matchAll(new RegExp(String.raw`\bfunction${nativeTrivia}\*?${nativeTrivia}${contract.name}${nativeTrivia}\(`,'g'))]
    assert.equal(declarations.length,1, `Generated state ${contract.name} declaration uniqueness drift`)
    const start=declarations[0].index-(contract.body.startsWith('async ') ? 6 : 0)
    const patchedBody=patchGeneratedState(contract.body)
    const branded=entry.source.slice(start,start+patchedBody.length)===patchedBody
    assert.ok(branded || (allowUnpatched && entry.source.slice(start,start+contract.body.length)===contract.body),
      `Generated state ${contract.role} ${contract.name} function structure drift`)
    recordState(entry.path,branded,entry.source.slice(start,start+contract.body.length)===contract.body)
    if (!topLevelRanges.has(entry.path)) topLevelRanges.set(entry.path,{source:entry.source,ranges:[]})
    topLevelRanges.get(entry.path).ranges.push({start,end:start+(branded?patchedBody:contract.body).length,name:contract.name})
  }
  for (const role of ['uniopc-cli-invocation-Dah1vX_Z.js','worker/worker.mjs']) {
    const entry=sources.find(entry=>generatedRolePath(entry.path,role))
    const original=role==='worker/worker.mjs'?'OPENCLAW_CLI_ENTRY_BASENAMES=new Set([`openclaw`,`openclaw.mjs`])':'OPENCLAW_CLI_ENTRY_BASENAMES = /* @__PURE__ */ new Set(["openclaw", "openclaw.mjs"])'
    const branded=patchGeneratedState(original)
    const oldCount=entry.source.split(original).length-1, newCount=entry.source.split(branded).length-1
    assert.ok(newCount===1 && oldCount===0 || allowUnpatched && oldCount===1 && newCount===0, `Generated state ${role} CLI entry recognition drift`)
    recordState(entry.path,newCount===1,oldCount===1)
  }
  for (const token of ['openclaw-agent-cli', 'uniopc-agent-cli']) {
    const expected = GENERATED_STATE_FUNCTIONS.filter(contract=>contract.name==='prepareGatewayAgentCliShim')
      .reduce((count,contract)=>{
        const entry=sources.find(entry=>generatedRolePath(entry.path,contract.role))
        const original=entry.source.includes(contract.body)
        return count+((original?contract.body:patchGeneratedState(contract.body)).split(token).length-1)
      },0)
    assert.equal(sources.reduce((count,entry)=>count+entry.source.split(token).length-1,0),expected, `Generated state unexpected CLI temporary prefix: ${token}`)
  }
  const escapedResiduals=new Map(sources.map(entry=>[entry.path,entry.source]))
  for (const {role,anchor} of ESCAPED_DATABASE_ANCHORS) {
    const entry=sources.find(entry=>generatedRolePath(entry.path,role)),patched=anchor.replace('openclaw-agent','uniopc-agent')
    const oldCount=entry.source.split(anchor).length-1,newCount=entry.source.split(patched).length-1
    assert.ok(newCount===1 && oldCount===0 || allowUnpatched && oldCount===1 && newCount===0,`Generated state escaped database ${role} anchor drift`)
    recordState(entry.path,newCount===1,oldCount===1)
    escapedResiduals.set(entry.path,escapedResiduals.get(entry.path).replace(newCount===1?patched:anchor,''))
  }
  for (const [path,source] of escapedResiduals) assert.ok(!/(?:incognito-)?(?:openclaw|uniopc)(?:-agent)?\\+\.sqlite/.test(source),`Generated state unexpected escaped database basename: ${path}`)
  const backupResiduals = new Map(sources.map(entry=>[entry.path,entry.source]))
  for (const {role,anchor} of BACKUP_OUTPUT_ANCHORS) {
    const entries=sources.filter(entry=>generatedRolePath(entry.path,role))
    assert.equal(entries.length,1, `Backup output requires exactly one ${role} role`)
    const entry=entries[0], patched=anchor.replaceAll('openclaw-backup','uniopc-backup')
    const oldCount=entry.source.split(anchor).length-1,newCount=entry.source.split(patched).length-1
    assert.ok(newCount===1 && oldCount===0 || allowUnpatched && oldCount===1 && newCount===0, `Backup output ${role} anchor/partial/structure drift`)
    recordState(entry.path,newCount===1,oldCount===1)
    backupResiduals.set(entry.path,backupResiduals.get(entry.path).replace(newCount===1?patched:anchor,''))
  }
  const cron=sources.find(entry=>generatedRolePath(entry.path,'register.backup-BFONF7_5.js'))
  const cronIdentity='const BACKUP_CRON_JOB_NAME = "openclaw-backup-scheduled";'
  assert.equal(cron.source.split(cronIdentity).length-1,1,'Backup scheduled-job technical identity drift')
  backupResiduals.set(cron.path,backupResiduals.get(cron.path).replace(cronIdentity,''))
  for (const [path,source] of backupResiduals) assert.ok(!/(?:openclaw|uniopc)-backup/.test(source),`Backup output unexpected generated name: ${path}`)
  for (const [path,{source,ranges}] of topLevelRanges) verifyGeneratedTopLevelRanges(source,ranges,path)
  for (const entry of sources) patches.set(entry.path,patchGeneratedState(entry.source))
  return patches
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
      const generatedStateSources = []
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
        if (bytes !== null && BRANDED_ENGINE_ROOT.test(normalized) && /^dist\//.test(normalized.replace(BRANDED_ENGINE_ROOT,''))
          && /\.(?:js|mjs|cjs|ts|mts|json|html|css|map|txt|xml|yaml|yml|toml|md)$/i.test(normalized)) {
          assert.ok(!bytes.includes(0), `NUL in generated state source: ${normalized}`)
          generatedStateSources.push({path:normalized,source:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)})
        }
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
            if (/(?:openclaw|uniopc)\.plugin\.json$/.test(normalized) && typeof metadata.name === 'string'
              && !isTechnicalPackageName(metadata.name)) {
              textViolations.push(...assertRuntimeFileTextBranded(metadata.name, `${normalized}:name`))
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
      inspectGeneratedStateSources(generatedStateSources)
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
