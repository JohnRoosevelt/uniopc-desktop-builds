import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertRuntimeEntryNamesBranded,
  assertRuntimeTextBranded,
  assertRuntimeWorkspaceTemplatesPackaged,
  classifyInternalTextPath,
  listResidualRuntimePaths,
} from './verify-uniopc-whitelabel-runtime.mjs'

test('runtime archive retains the workspace templates required for first launch', () => {
  const directory = 'tools/node-v24/lib/node_modules/uniopc-engine/docs/reference/templates/'
  const names = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md'].map(name => `${directory}${name}`)
  assertRuntimeWorkspaceTemplatesPackaged(names)
  assert.throws(() => assertRuntimeWorkspaceTemplatesPackaged(names.filter(name => !name.endsWith('AGENTS.md'))), /AGENTS.md/)
})

test('runtime path scan rejects the upstream engine directory and upstream scoped SDK dependencies', () => {
  assertRuntimeEntryNamesBranded([
    'bin/uniopc-engine',
    'tools/node/lib/node_modules/@uniopc/ai/dist/index.js',
    'tools/node-v24/lib/node_modules/uniopc-engine/dist/extensions/telegram/uniopc.plugin.json',
  ])
  assert.throws(() => assertRuntimeEntryNamesBranded(['tools/node/lib/node_modules/openclaw/openclaw.mjs']), /Unbranded runtime path/)
  assert.throws(() => assertRuntimeEntryNamesBranded(['tools/node-v24/lib/node_modules/uniopc-engine/openclaw.mjs']), /Unbranded runtime path/)
  assert.throws(() => assertRuntimeEntryNamesBranded(['tools/node-v24/lib/node_modules/uniopc-engine/dist/openclaw-root-HASH.js']), /Unbranded runtime path/)
  assert.throws(() => assertRuntimeEntryNamesBranded(['tools/node-v24/lib/node_modules/uniopc-engine/dist/extensions/demo/assets/openclaw-wallpaper.png']), /Unbranded runtime path/)
  assert.throws(() => assertRuntimeEntryNamesBranded(['tools/node-v24/lib/node_modules/uniopc-engine/dist/extensions/demo/openclaw.plugin.json']), /Unbranded runtime path/)
  for (const root of ['tools/node/node_modules', 'tools/node-v24/lib/node_modules/uniopc-engine/node_modules']) {
    assert.throws(() => assertRuntimeEntryNamesBranded([`${root}/@openclaw/ai/dist/index.js`]), /Unbranded runtime path/)
    assert.throws(() => assertRuntimeEntryNamesBranded([`${root}/@openclaw/`]), /Unbranded runtime path/)
  }
  assert.throws(() => assertRuntimeEntryNamesBranded(['bin/openclaw']), /Unbranded runtime path/)
  assert.throws(() => assertRuntimeEntryNamesBranded(['小龙虾.log']), /Unbranded runtime path/)
})

test('runtime path report enumerates every exact upstream path residual', () => {
  assert.deepEqual(listResidualRuntimePaths([
    'tools/node/lib/node_modules/@openclaw/ai/dist/index.js',
    'tools/node/lib/node_modules/@openclaw/fs-safe/package.json',
    'tools/node-v24/lib/node_modules/uniopc-engine/dist/extensions/telegram/openclaw.plugin.json',
    'bin/uniopc-engine',
  ]), [
    'tools/node-v24/lib/node_modules/uniopc-engine/dist/extensions/telegram/openclaw.plugin.json',
    'tools/node/lib/node_modules/@openclaw/ai',
    'tools/node/lib/node_modules/@openclaw/fs-safe',
  ])
})

test('scanner classifies only compiled Control UI code as internal source', () => {
  assert.match(
    classifyInternalTextPath('tools/node-v24/lib/node_modules/uniopc-engine/dist/control-ui-entry.js'),
    /internal API\/property identifiers/
  )
  assert.equal(classifyInternalTextPath('tools/node-v24/lib/node_modules/uniopc-engine/dist/channel-catalog.json'), null)
})

test('runtime text scan rejects display branding and permits only declared attribution headers', () => {
  assertRuntimeTextBranded('Uniopc gateway ready')
  assertRuntimeTextBranded('OPENCLAW_ATTRIBUTION_PRODUCT = "OpenClaw"')
  assert.throws(() => assertRuntimeTextBranded('OpenClaw gateway ready'), /Unbranded user-facing runtime string/)
  assert.throws(() => assertRuntimeTextBranded('小龙虾已启动'), /Unbranded user-facing runtime string/)
})

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectWindowsNativeRequireSources,
  WINDOWS_NATIVE_REQUIRE_ORIGINAL,
  WINDOWS_NATIVE_REQUIRE_PATCHED,
  WINDOWS_WORKER_NATIVE_REQUIRE_ORIGINAL,
  WINDOWS_WORKER_NATIVE_REQUIRE_PATCHED,
  verifyRuntimeDirectory,
} from './verify-uniopc-whitelabel-runtime.mjs'
import { buildOpenclawRuntimeBundle } from './build-openclaw-runtime-bundle.mjs'

// Complete installed 2026.8.1 bytes, independent of production hash constants.
const nativePrefixFixture = [
  "import { c as isRecord } from \"./record-coerce-DItp3I4t.js\";",
  "import { t as sameFileIdentity } from \"./file-identity-CaVBmM56.js\";",
  "import { a as isPathInside } from \"./path-D138yf8v.js\";",
  "import \"./fs-safe-gVoExnQ2.js\";",
  "import { i as openRootFileSync } from \"./root-file-B4L4VJ7-.js\";",
  "import { t as isPathStrictlyInside } from \"./path-guards-CQoZeoCG.js\";",
  "import \"./boundary-file-read-h_n3tTfV.js\";",
  "import { a as getPluginCache, f as withPluginCache, n as bindPluginCacheRoot, o as getPluginCacheRoot, p as getPluginSdkHostFacts, s as getPluginCacheSource } from \"./plugin-cache-DMPn6vOK.js\";",
  "import { a as pluginCacheRealpathSync, r as pluginCacheExistsSync } from \"./plugin-cache-files-Bob4xqJ3.js\";",
  "import { a as listWorkspacePackageExportAliasEntries, c as resolvePluginLoaderTryNative, i as isPluginSdkAliasSpecifier, n as buildPluginLoaderJitiOptions, o as preparePluginLoaderAliases, r as createPluginLoaderModuleCacheKey } from \"./sdk-alias-BgJEvT_m.js\";",
  "import Module, { createRequire } from \"node:module\";",
  "import { fileURLToPath, pathToFileURL } from \"node:url\";",
  "import fs from \"node:fs\";",
  "import path from \"node:path\";",
  "//#region src/shared/import-specifier.ts",
  "/**",
  "* On Windows, Node's ESM loader requires absolute paths to be expressed as",
  "* file:// URLs. Raw drive-letter paths like C:\\... are parsed as URL schemes.",
  "*/",
  "function toSafeImportPath(specifier) {",
  "\tif (process.platform !== \"win32\") return specifier;",
  "\tif (specifier.startsWith(\"file://\")) return specifier;",
  "\tif (path.win32.isAbsolute(specifier)) return pathToFileURL(specifier, { windows: true }).href;",
  "\treturn specifier;",
  "}",
  "//#endregion",
  ""
].join('\n')
const nativeRegionFixture = [
  "//#region src/plugins/native-module-require.ts",
  "const nodeRequire = createRequire(import.meta.url);",
  "const moduleWithResolver$1 = Module;",
  "/** True for file extensions Node can load through the native JS module loader. */",
  "function isJavaScriptModulePath(modulePath) {",
  "\treturn [",
  "\t\t\".js\",",
  "\t\t\".mjs\",",
  "\t\t\".cjs\"",
  "\t].includes(path.extname(modulePath).toLowerCase());",
  "}",
  "function isMissingTargetModuleError(error, modulePath) {",
  "\tif (error.code !== \"MODULE_NOT_FOUND\" || typeof error.message !== \"string\") return false;",
  "\tconst firstLine = error.message.split(\"\\n\", 1)[0] ?? \"\";",
  "\treturn firstLine.includes(`'${modulePath}'`) || firstLine.includes(`\"${modulePath}\"`);",
  "}",
  "function isSourceTransformFallbackError(error, modulePath) {",
  "\tif (!error || typeof error !== \"object\") return false;",
  "\tconst candidate = error;",
  "\tconst code = candidate.code;",
  "\treturn code === \"ERR_REQUIRE_ESM\" || code === \"ERR_REQUIRE_ASYNC_MODULE\" || code === \"ERR_REQUIRE_ESM_RACE_CONDITION\" || isMissingTargetModuleError(candidate, modulePath);",
  "}",
  "/** Attempts native require before falling back to source transform paths. */",
  "function tryNativeRequireJavaScriptModule(modulePath, options = {}) {",
  "\tif (process.platform === \"win32\" && options.allowWindows !== true) return { ok: false };",
  "\tif (!isJavaScriptModulePath(modulePath)) return { ok: false };",
  "\ttry {",
  "\t\treturn {",
  "\t\t\tok: true,",
  "\t\t\tmoduleExport: requireWithOptionalAliases(modulePath, options.aliasMap)",
  "\t\t};",
  "\t} catch (error) {",
  "\t\tconst code = error && typeof error === \"object\" ? error.code : void 0;",
  "\t\tif (isSourceTransformFallbackError(error, modulePath) || options.fallbackOnNativeError || options.fallbackOnMissingDependency === true && (code === \"MODULE_NOT_FOUND\" || code === \"ERR_MODULE_NOT_FOUND\")) return { ok: false };",
  "\t\tthrow error;",
  "\t}",
  "}",
  "/** Clears native and source-transformed modules within the plugin dependency root. */",
  "function clearPluginModuleRequireCache(modulePath, options = {}) {",
  "\ttry {",
  "\t\tconst resolved = nodeRequire.resolve(modulePath);",
  "\t\tclearRequireCacheSubtree(resolved, resolveRequireCachePath(options.dependencyRoot ?? path.dirname(resolved)), /* @__PURE__ */ new Set());",
  "\t} catch {}",
  "}",
  "function resolveRequireCachePath(targetPath) {",
  "\ttry {",
  "\t\treturn fs.realpathSync.native(targetPath);",
  "\t} catch {",
  "\t\treturn path.resolve(targetPath);",
  "\t}",
  "}",
  "function clearRequireCacheSubtree(resolvedPath, dependencyRoot, seen) {",
  "\tif (seen.has(resolvedPath)) return;",
  "\tseen.add(resolvedPath);",
  "\tconst cached = nodeRequire.cache[resolvedPath];",
  "\tif (cached) {",
  "\t\tfor (const child of cached.children) if (isPathInside(dependencyRoot, child.id)) clearRequireCacheSubtree(child.id, dependencyRoot, seen);",
  "\t}",
  "\tdelete nodeRequire.cache[resolvedPath];",
  "}",
  "function requireWithOptionalAliases(modulePath, aliasMap) {",
  "\treturn withNativeRequireAliases(aliasMap, () => createRequire(import.meta.url)(modulePath));",
  "}",
  "/** Runs a native require block with temporary CJS/ESM alias hooks and restores both afterward. */",
  "function withNativeRequireAliases(aliasMap, run) {",
  "\tif (!aliasMap || !moduleWithResolver$1[\"_resolveFilename\"]) return run();",
  "\tconst resolveAlias = typeof aliasMap === \"function\" ? aliasMap : (specifier) => aliasMap[specifier];",
  "\tconst originalResolveFilename = moduleWithResolver$1[\"_resolveFilename\"];",
  "\tconst esmHooks = moduleWithResolver$1.registerHooks?.({ resolve(specifier, context, nextResolve) {",
  "\t\tconst aliasTarget = resolveAlias(specifier);",
  "\t\tif (aliasTarget) return {",
  "\t\t\tshortCircuit: true,",
  "\t\t\turl: pathToFileURL(aliasTarget).href",
  "\t\t};",
  "\t\treturn nextResolve(specifier, context);",
  "\t} });",
  "\tmoduleWithResolver$1[\"_resolveFilename\"] = ((request, parent, isMain, options) => {",
  "\t\tconst aliasTarget = resolveAlias(request);",
  "\t\tif (aliasTarget) return aliasTarget;",
  "\t\treturn originalResolveFilename(request, parent, isMain, options);",
  "\t});",
  "\ttry {",
  "\t\treturn run();",
  "\t} finally {",
  "\t\tmoduleWithResolver$1[\"_resolveFilename\"] = originalResolveFilename;",
  "\t\tesmHooks?.deregister();",
  "\t}",
  "}",
  "//#endregion"
].join('\n')
const nativeSource = body => nativePrefixFixture + nativeRegionFixture.replace(WINDOWS_NATIVE_REQUIRE_ORIGINAL, body) + '\n'
const workerPrefixFixture = [
  "import Module,{createRequire,flushCompileCache}from\"node:module\";import*as crypto$11 from\"node:crypto\";import crypto$1,{X509Certificate,createCipheriv,createDecipheriv,createHash,createHmac,createPrivateKey,hash,randomBytes,randomInt,randomUUID,sign,timingSafeEqual}from\"node:crypto\";import*as fssync from\"node:fs\";import fs,{accessSync,appendFileSync,chmodSync,close,closeSync,constants,createReadStream,createWriteStream,existsSync,globSync,linkSync,lstatSync,mkdirSync,openSync,promises,readFileSync,readSync,readdirSync,readlinkSync,realpathSync,renameSync,rmSync,rmdirSync,stat,statSync,unlinkSync,unwatchFile,watch,watchFile,write,writeFileSync,writev,default as openClawRootFsSync}from\"node:fs\";import*as fs$16 from\"node:fs/promises\";import fs$1,{access,chmod,copyFile,lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rm,stat as stat$1,writeFile,default as openClawRootFs}from\"node:fs/promises\";import*as path$14 from\"node:path\";import path,{basename,dirname,isAbsolute,join,posix,relative,resolve,sep,win32}from\"node:path\";import{URL as URL$1,domainToASCII,fileURLToPath,format,pathToFileURL}from\"node:url\";"
].join('\n')
const workerBlockFixture = [
  "function toSafeImportPath(Ot){return process.platform!==`win32`||Ot.startsWith(`file://`)?Ot:path.win32.isAbsolute(Ot)?pathToFileURL(Ot,{windows:!0}).href:Ot}var init_import_specifier=__esmMin((()=>{}));function isJavaScriptModulePath(Ot){return[`.js`,`.mjs`,`.cjs`].includes(path.extname(Ot).toLowerCase())}function isMissingTargetModuleError(Ot,Zt){if(Ot.code!==`MODULE_NOT_FOUND`||typeof Ot.message!=`string`)return!1;let _n=Ot.message.split(`",
  "`,1)[0]??``;return _n.includes(`'${Zt}'`)||_n.includes(`\"${Zt}\"`)}function isSourceTransformFallbackError(Ot,Zt){if(!Ot||typeof Ot!=`object`)return!1;let _n=Ot,Dn=_n.code;return Dn===`ERR_REQUIRE_ESM`||Dn===`ERR_REQUIRE_ASYNC_MODULE`||Dn===`ERR_REQUIRE_ESM_RACE_CONDITION`||isMissingTargetModuleError(_n,Zt)}function tryNativeRequireJavaScriptModule(Ot,Zt={}){if(process.platform===`win32`&&Zt.allowWindows!==!0||!isJavaScriptModulePath(Ot))return{ok:!1};try{return{ok:!0,moduleExport:requireWithOptionalAliases(Ot,Zt.aliasMap)}}catch(_n){let Dn=_n&&typeof _n==`object`?_n.code:void 0;if(isSourceTransformFallbackError(_n,Ot)||Zt.fallbackOnNativeError||Zt.fallbackOnMissingDependency===!0&&(Dn===`MODULE_NOT_FOUND`||Dn===`ERR_MODULE_NOT_FOUND`))return{ok:!1};throw _n}}function clearPluginModuleRequireCache(Ot,Zt={}){try{let _n=nodeRequire$2.resolve(Ot);clearRequireCacheSubtree(_n,resolveRequireCachePath(Zt.dependencyRoot??path.dirname(_n)),new Set)}catch{}}function resolveRequireCachePath(Ot){try{return fs.realpathSync.native(Ot)}catch{return path.resolve(Ot)}}function clearRequireCacheSubtree(Ot,Zt,_n){if(_n.has(Ot))return;_n.add(Ot);let Dn=nodeRequire$2.cache[Ot];if(Dn)for(let Ot of Dn.children)isPathInside(Zt,Ot.id)&&clearRequireCacheSubtree(Ot.id,Zt,_n);delete nodeRequire$2.cache[Ot]}function requireWithOptionalAliases(Ot,Zt){return withNativeRequireAliases(Zt,()=>createRequire(import.meta.url)(Ot))}function withNativeRequireAliases(Ot,Zt){if(!Ot||!moduleWithResolver$1._resolveFilename)return Zt();let _n=typeof Ot==`function`?Ot:Zt=>Ot[Zt],Dn=moduleWithResolver$1._resolveFilename,kn=moduleWithResolver$1.registerHooks?.({resolve(Ot,Zt,Dn){let kn=_n(Ot);return kn?{shortCircuit:!0,url:pathToFileURL(kn).href}:Dn(Ot,Zt)}});moduleWithResolver$1._resolveFilename=((Ot,Zt,kn,Pn)=>_n(Ot)||Dn(Ot,Zt,kn,Pn));try{return Zt()}finally{moduleWithResolver$1._resolveFilename=Dn,kn?.deregister()}}var nodeRequire$2,moduleWithResolver$1,init_native_module_require=__esmMin((()=>{init_path_guards(),nodeRequire$2=createRequire(import.meta.url),moduleWithResolver$1=Module}));"
].join('\n')
const workerSource = (patched=true) => workerPrefixFixture+'\n'+(patched
  ?workerBlockFixture.replace(WINDOWS_WORKER_NATIVE_REQUIRE_ORIGINAL,WINDOWS_WORKER_NATIVE_REQUIRE_PATCHED)
  :workerBlockFixture)+'function readPackageName$2(){}'
const sourceEntry = source => ({path:'dist/arbitrary-hash.js',source})

test('Windows native verifier checks the actual unique helper, URL import and exact region/require/error structure', () => {
  const patched=nativeSource(WINDOWS_NATIVE_REQUIRE_PATCHED)
  inspectWindowsNativeRequireSources([sourceEntry(patched),{path:'dist/worker/worker.mjs',source:workerSource()}])
  for(const sources of [
    [],[sourceEntry(nativeSource(WINDOWS_NATIVE_REQUIRE_ORIGINAL))],
    [sourceEntry(patched),{path:'dist/duplicate.js',source:patched}],
    [sourceEntry(`// ${WINDOWS_NATIVE_REQUIRE_PATCHED.split('\n').join('\n// ')}`)],
    [sourceEntry('const marker='+JSON.stringify(patched))],
    [sourceEntry(patched.replace('fileURLToPath, pathToFileURL','fileURLToPath as renamed, pathToFileURL'))],
    [sourceEntry(patched.replace('src/plugins/native-module-require.ts','src/plugins/drift.ts'))],
    [sourceEntry('// injected prefix comment\n'+patched)],
    [sourceEntry('function nested(){\n'+patched+'\n}')],
    [sourceEntry(patched.replace('createRequire(import.meta.url);','createRequire(import.meta.url + "drift");'))],
    [sourceEntry(patched.replace('const firstLine = error.message.split', 'const firstLine = error.other.split'))],
    [sourceEntry(patched.replace('moduleWithResolver$1["_resolveFilename"] = originalResolveFilename;', 'moduleWithResolver$1["_resolveFilename"] = null;'))],
    [sourceEntry(patched.replace('esmHooks?.deregister();', 'void esmHooks;'))],
    [sourceEntry(patched),{path:'dist/comment.js',source:'// '+WINDOWS_NATIVE_REQUIRE_PATCHED}],
    [sourceEntry(patched+'\n'+WINDOWS_NATIVE_REQUIRE_PATCHED.replace('function tryNativeRequireJavaScriptModule(', 'function/**/tryNativeRequireJavaScriptModule/**/('))],
    [sourceEntry(patched+'\n'+WINDOWS_NATIVE_REQUIRE_PATCHED.replace('function tryNativeRequireJavaScriptModule(', 'function* tryNativeRequireJavaScriptModule('))],


    [sourceEntry(patched.replace('requireWithOptionalAliases(modulePath, options.aliasMap)','requireWithOptionalAliases("wrong", options.aliasMap)'))],
    [sourceEntry(patched.replace('isSourceTransformFallbackError(error, modulePath)','isSourceTransformFallbackError(error, "wrong")'))],
  ]) assert.throws(()=>inspectWindowsNativeRequireSources([...sources,{path:'dist/worker/worker.mjs',source:workerSource()}]),/exactly one|patch missing|drift/)
})

async function nativeArchive(t, {platform='win32', source=nativeSource(WINDOWS_NATIVE_REQUIRE_PATCHED)}={}) {
  const root=await mkdtemp(join(tmpdir(),'uniopc-native-verifier-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const engine=join(root,'stage/tools/node/node_modules/uniopc-engine')
  await mkdir(join(engine,'dist'),{recursive:true})
  const templates=join(engine,'docs/reference/templates');await mkdir(templates,{recursive:true})
  for(const name of ['AGENTS.md','SOUL.md','TOOLS.md','IDENTITY.md','USER.md','BOOTSTRAP.md']) await writeFile(join(templates,name),'Uniopc template')
  await writeFile(join(engine,'dist/loader-hash.js'),source)
  await mkdir(join(engine,'dist/worker'),{recursive:true})
  await writeFile(join(engine,'dist/worker/worker.mjs'),workerSource())
  const output=join(root,'output');await mkdir(output)
  const archive=`uniopc-engine-runtime-${platform}-x64.tar.gz`
  execFileSync('tar',['-czf',join(output,archive),'-C',join(root,'stage'),'tools'])
  const bytes=await readFile(join(output,archive))
  await writeFile(join(output,'uniopc-engine-runtime.catalog.json'),JSON.stringify({artifacts:[{
    version:'2026.8.1',platform,arch:'x64',archive,sizeBytes:bytes.length,
  }]}))
  return {root,output,engine}
}

test('Windows cached archive verifier rejects missing/unpatched/duplicate/drifted helpers and accepts a patched temporary archive', async t => {
  const valid=await nativeArchive(t)
  assert.equal((await verifyRuntimeDirectory(valid.output)).artifactCount,1)
  for(const source of ['export const nothing=true;',nativeSource(WINDOWS_NATIVE_REQUIRE_ORIGINAL),
    nativeSource(WINDOWS_NATIVE_REQUIRE_PATCHED.replace('fileURLToPath(nativeUrl)','String(nativeUrl)'))]){
    const fixture=await nativeArchive(t,{source})
    await assert.rejects(verifyRuntimeDirectory(fixture.output),/exactly one|patch missing/)
  }
  await writeFile(join(valid.engine,'dist/worker/worker.mjs'),workerSource(false))
  execFileSync('tar',['-czf',join(valid.output,'uniopc-engine-runtime-win32-x64.tar.gz'),'-C',join(valid.root,'stage'),'tools'])
  await assert.rejects(verifyRuntimeDirectory(valid.output),/worker compatibility patch missing/)
  await writeFile(join(valid.engine,'dist/worker/worker.mjs'),workerSource())
  await writeFile(join(valid.engine,'dist/duplicate.js'),nativeSource(WINDOWS_NATIVE_REQUIRE_PATCHED))
  execFileSync('tar',['-czf',join(valid.output,'uniopc-engine-runtime-win32-x64.tar.gz'),'-C',join(valid.root,'stage'),'tools'])
  await assert.rejects(verifyRuntimeDirectory(valid.output),/exactly one/)
  const unix=await nativeArchive(t,{platform:'darwin',source:'export const unix=true;'})
  assert.equal((await verifyRuntimeDirectory(unix.output)).artifactCount,1)
})

test('Windows builder existing-size skip rejects an unpatched cached archive before returning success', {skip:process.platform!=='win32'}, async t => {
  const fixture=await nativeArchive(t,{source:nativeSource(WINDOWS_NATIVE_REQUIRE_ORIGINAL)})
  await assert.rejects(buildOpenclawRuntimeBundle({outputDir:fixture.output,platform:'win32',arch:'x64'}),/patch missing/)
})

test('dual loader roles reject missing, duplicate, nested, string/comment worker copies and prefix/block drift', () => {
  const main=sourceEntry(nativeSource(WINDOWS_NATIVE_REQUIRE_PATCHED))
  const original=workerSource(false),patched=workerSource()
  const entry=source=>({path:'dist/worker/worker.mjs',source})
  assert.equal(inspectWindowsNativeRequireSources([main,entry(patched)]).length,2)
  assert.throws(()=>inspectWindowsNativeRequireSources([main]),/worker helper/)
  assert.throws(()=>inspectWindowsNativeRequireSources([main,entry(original)]),/worker compatibility patch missing/)
  assert.equal(inspectWindowsNativeRequireSources([main,entry(original)],{allowUnpatched:true})[1].role,'worker')
  for(const source of [
    patched.replace('openClawRootFsSync','changedRootFs'),
    patched.replace('isSourceTransformFallbackError(_n,Ot)','isSourceTransformFallbackError(_n,Zt)'),
    patched.replace('kn?.deregister()','void kn'),
    workerPrefixFixture+'\n/*'+patched.slice(workerPrefixFixture.length)+'*/',
    workerPrefixFixture+'\nconst stringCopy='+JSON.stringify(patched.slice(workerPrefixFixture.length))+';',
    workerPrefixFixture+'\nfunction nested(){'+patched.slice(workerPrefixFixture.length)+'}',
    workerPrefixFixture+'\nfunction nested(){'+patched.slice(workerPrefixFixture.length)+'}const tryNativeRequireJavaScriptModule=0;',
    patched.replace(WINDOWS_WORKER_NATIVE_REQUIRE_PATCHED,'/* helper moved out */')+'function outer(){'+WINDOWS_WORKER_NATIVE_REQUIRE_PATCHED+'}',
  ]) assert.throws(()=>inspectWindowsNativeRequireSources([main,entry(source)]),/drift|exactly one|patch missing/)
  assert.throws(()=>inspectWindowsNativeRequireSources([main,entry(patched),{path:'dist/third.js',source:WINDOWS_WORKER_NATIVE_REQUIRE_PATCHED}]),/exactly one/)
  assert.throws(()=>inspectWindowsNativeRequireSources([main,entry(patched+';const tryNativeRequireJavaScriptModule=0;')]),/top-level/)
})

test('standalone Windows archive verifier and VM uniqueness checks work without node_modules and never evaluate worker code', async t => {
  const fixture=await nativeArchive(t)
  const marker=join(fixture.root,'must-not-evaluate')
  await writeFile(join(fixture.engine,'dist/worker/worker.mjs'),workerSource()
    +';fs.writeFileSync('+JSON.stringify(marker)+',"bad");throw new Error("must not evaluate");')
  execFileSync('tar',['-czf',join(fixture.output,'uniopc-engine-runtime-win32-x64.tar.gz'),'-C',join(fixture.root,'stage'),'tools'])
  const script=join(fixture.root,'verify.mjs')
  await writeFile(script,await readFile(new URL('./verify-uniopc-whitelabel-runtime.mjs',import.meta.url)))
  const env={...process.env}
  for(const key of Object.keys(env))if(['NODE_PATH','NODE_OPTIONS'].includes(key.toUpperCase()))delete env[key]
  assert.ok(!(await readdir(fixture.root)).includes('node_modules'))
  const result=execFileSync(process.execPath,[await realpath(script),fixture.output],
    {cwd:fixture.root,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000})
  assert.match(result,/branding verified \(1 artifact\(s\)\)/)
  await assert.rejects(readFile(marker),error=>error.code==='ENOENT')
})

test('Windows native archive collection accepts literal U+FFFD independently of branding readability', async t => {
  const fixture=await nativeArchive(t,{source:nativeSource(WINDOWS_NATIVE_REQUIRE_PATCHED)+'\nconst replacement="�";'})
  await writeFile(join(fixture.engine,'dist/worker/worker.mjs'),workerSource()+'\nconst replacement="�";')
  const repack=()=>execFileSync('tar',['-czf',join(fixture.output,'uniopc-engine-runtime-win32-x64.tar.gz'),'-C',join(fixture.root,'stage'),'tools'])
  repack()
  assert.equal((await verifyRuntimeDirectory(fixture.output)).artifactCount,1)
  // A third helper must still count even when branding considers it unreadable.
  await writeFile(join(fixture.engine,'dist/third.js'),nativeSource(WINDOWS_NATIVE_REQUIRE_PATCHED)+'\nconst replacement="�";')
  repack()
  await assert.rejects(verifyRuntimeDirectory(fixture.output),/exactly one readable helper/)
})

test('Windows native archive collection rejects invalid UTF-8, NUL and preserved BOM for either role', async t => {
  for(const role of ['readable','worker']){
    const fixture=await nativeArchive(t)
    const file=join(fixture.engine,role==='readable'?'dist/loader-hash.js':'dist/worker/worker.mjs')
    const original=await readFile(file)
    for(const [bytes,error] of [
      [Buffer.concat([original,Buffer.from('\n// '),Buffer.from([0xc3,0x28])]),/encoded data|encoding|utf-8/i],
      [Buffer.concat([original,Buffer.from('\n// '),Buffer.from([0])]),/NUL in Windows native loader candidate/],
      [Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),original]),/prefix.*drift/],
    ]){
      await writeFile(file,bytes)
      execFileSync('tar',['-czf',join(fixture.output,'uniopc-engine-runtime-win32-x64.tar.gz'),'-C',join(fixture.root,'stage'),'tools'])
      await assert.rejects(verifyRuntimeDirectory(fixture.output),error,role)
    }
  }
})
