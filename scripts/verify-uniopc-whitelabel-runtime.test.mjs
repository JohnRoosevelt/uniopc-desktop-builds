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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectWindowsNativeRequireSources,
  WINDOWS_NATIVE_REQUIRE_ORIGINAL,
  WINDOWS_NATIVE_REQUIRE_PATCHED,
  verifyRuntimeDirectory,
} from './verify-uniopc-whitelabel-runtime.mjs'
import { buildOpenclawRuntimeBundle } from './build-openclaw-runtime-bundle.mjs'

const nativeSource = body => 'import { fileURLToPath, pathToFileURL } from "node:url";\n'
  + '//#region src/plugins/native-module-require.ts\n' + body + '\n//#endregion\n'
const sourceEntry = source => ({path:'dist/arbitrary-hash.js',source})

test('Windows native verifier checks the actual unique helper, URL import and exact region/require/error structure', () => {
  const patched=nativeSource(WINDOWS_NATIVE_REQUIRE_PATCHED)
  inspectWindowsNativeRequireSources([sourceEntry(patched)])
  for(const sources of [
    [],[sourceEntry(nativeSource(WINDOWS_NATIVE_REQUIRE_ORIGINAL))],
    [sourceEntry(patched),{path:'dist/duplicate.js',source:patched}],
    [sourceEntry(`// ${WINDOWS_NATIVE_REQUIRE_PATCHED.split('\n').join('\n// ')}`)],
    [sourceEntry('const marker='+JSON.stringify(patched))],
    [sourceEntry(patched.replace('fileURLToPath, pathToFileURL','fileURLToPath as renamed, pathToFileURL'))],
    [sourceEntry(patched.replace('src/plugins/native-module-require.ts','src/plugins/drift.ts'))],
    [sourceEntry(patched.replace('requireWithOptionalAliases(modulePath, options.aliasMap)','requireWithOptionalAliases("wrong", options.aliasMap)'))],
    [sourceEntry(patched.replace('isSourceTransformFallbackError(error, modulePath)','isSourceTransformFallbackError(error, "wrong")'))],
  ]) assert.throws(()=>inspectWindowsNativeRequireSources(sources),/exactly one|patch missing|drift/)
})

async function nativeArchive(t, {platform='win32', source=nativeSource(WINDOWS_NATIVE_REQUIRE_PATCHED)}={}) {
  const root=await mkdtemp(join(tmpdir(),'uniopc-native-verifier-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const engine=join(root,'stage/tools/node/node_modules/uniopc-engine')
  await mkdir(join(engine,'dist'),{recursive:true})
  const templates=join(engine,'docs/reference/templates');await mkdir(templates,{recursive:true})
  for(const name of ['AGENTS.md','SOUL.md','TOOLS.md','IDENTITY.md','USER.md','BOOTSTRAP.md']) await writeFile(join(templates,name),'Uniopc template')
  await writeFile(join(engine,'dist/loader-hash.js'),source)
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
