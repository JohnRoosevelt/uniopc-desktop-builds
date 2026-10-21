import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Module, { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { WINDOWS_NATIVE_REQUIRE_ORIGINAL, WINDOWS_NATIVE_REQUIRE_PATCHED, WINDOWS_WORKER_NATIVE_REQUIRE_ORIGINAL, WINDOWS_WORKER_NATIVE_REQUIRE_PATCHED } from './verify-uniopc-whitelabel-runtime.mjs'

import {
  isMachOMagic,
  patchWindowsNativeModuleRequire,
  addLocalMediaIdToChatAttachmentSchema,
  preserveLocalMediaIdInRpcAttachmentNormalizer,
  resolveTrustedLocalMediaInAttachmentParser,
  mergeRuntimeCatalog,
  nodeVersionMatchesRelease,
  parseRuntimeBuildTarget,
  runtimeSigningMode,
  renameInstalledEngine,
  scrubAssistantAttachmentsFromModelContextSource,
  scrubStreamFailureMarkersFromAgentPromptSource,
} from './build-openclaw-runtime-bundle.mjs'

test('renames Unix and Windows installs while preserving npm self identity', async () => {
  for (const packageRelative of [
    'tools/node-v24.19.0/lib/node_modules/openclaw',
    'tools/node/node_modules/openclaw',
  ]) {
    const prefix = mkdtempSync(join(tmpdir(), 'uniopc-engine-rename-'))
    try {
      const source = join(prefix, packageRelative)
      mkdirSync(join(source, 'docs', 'reference', 'templates'), { recursive: true })
      writeFileSync(join(source, 'openclaw.mjs'), '#!/usr/bin/env node\n')
      mkdirSync(join(source, 'dist'), { recursive: true })
      writeFileSync(join(source, 'dist', 'entry.js'), [
        'const ENTRY_WRAPPER_PAIRS = [',
        '  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },',
        '  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.mjs" },',
        ']\n',
      ].join('\n'))
      writeFileSync(join(source, 'docs', 'openclaw.md'), 'upstream docs')
      for (const name of ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md']) {
        writeFileSync(join(source, 'docs', 'reference', 'templates', name), 'OpenClaw workspace template\n')
      }
      writeFileSync(join(source, 'package.json'), JSON.stringify({
        name: 'openclaw',
        bin: { openclaw: 'openclaw.mjs' },
        exports: { './cli-entry': './openclaw.mjs' },
        scripts: { start: 'node openclaw.mjs' },
        directories: { doc: 'docs' },
      }))

      await renameInstalledEngine(prefix)
      const target = join(prefix, packageRelative.replace(/openclaw$/, 'uniopc-engine'))
      const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
      assert.equal(manifest.name, 'openclaw')
      assert.deepEqual(manifest.bin, { 'uniopc-engine': 'uniopc-engine.mjs' })
      assert.equal(manifest.exports['./cli-entry'], './uniopc-engine.mjs')
      assert.equal(manifest.scripts.start, 'node uniopc-engine.mjs')
      assert.equal(manifest.directories.doc, undefined)
      assert.equal(existsSync(join(target, 'uniopc-engine.mjs')), true)
      assert.equal(existsSync(join(target, 'openclaw.mjs')), false)
      const compiledEntry = readFileSync(join(target, 'dist', 'entry.js'), 'utf8')
      assert.equal(compiledEntry.includes('wrapperBasename: "openclaw.mjs"'), false)
      assert.equal(compiledEntry.match(/wrapperBasename: "uniopc-engine.mjs"/g)?.length, 2)
      assert.equal(existsSync(join(target, 'docs', 'openclaw.md')), false)
      assert.equal(readFileSync(join(target, 'docs', 'reference', 'templates', 'AGENTS.md'), 'utf8'), 'Uniopc workspace template\n')
    } finally {
      rmSync(prefix, { recursive: true, force: true })
    }
  }
})

test('parses only supported explicit runtime build targets', () => {
  assert.deepEqual(
    parseRuntimeBuildTarget(['--platform', 'darwin', '--arch', 'arm64']),
    { platform: 'darwin', arch: 'arm64' },
  )
  assert.deepEqual(
    parseRuntimeBuildTarget(['--platform', 'linux', '--arch', 'arm64']),
    { platform: 'linux', arch: 'arm64' },
  )
  assert.throws(
    () => parseRuntimeBuildTarget(['--platform', 'darwin', '--arch', 'ia32']),
    /Unsupported runtime target/,
  )
})

test('recognizes Mach-O file headers without spawning the file utility', () => {
  assert.equal(isMachOMagic(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])), true)
  assert.equal(isMachOMagic(Buffer.from([0xca, 0xfe, 0xba, 0xbe])), true)
  assert.equal(isMachOMagic(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), false)
})

test('allows unsigned runtime archives only for explicit non-CI local builds', () => {
  assert.equal(runtimeSigningMode({}), 'required')
  assert.equal(runtimeSigningMode({ UNIOPC_RUNTIME_ALLOW_UNSIGNED_LOCAL: '1' }), 'skip-local')
  assert.equal(runtimeSigningMode({ UNIOPC_RUNTIME_ALLOW_UNSIGNED_LOCAL: '1', CI: '1' }), 'rejected')
  assert.equal(runtimeSigningMode({}, { allowUnsignedLocal: true }), 'skip-local')
  assert.equal(runtimeSigningMode({ CI: '1' }, { allowUnsignedLocal: true }), 'rejected')
})

test('accepts only the exact Node.js release version', () => {
  assert.equal(nodeVersionMatchesRelease('v24.19.0'), true)
  assert.equal(nodeVersionMatchesRelease('24.19.0'), true)
  assert.equal(nodeVersionMatchesRelease('24.18.0'), false)
  assert.equal(nodeVersionMatchesRelease('24.19.1'), false)
  assert.equal(nodeVersionMatchesRelease('25.0.0'), false)
})

test('merges catalog records deterministically by platform and architecture', () => {
  const catalog = mergeRuntimeCatalog(
    {
      artifacts: [{ platform: 'win32', arch: 'x64', archive: 'win.tgz' }],
    },
    { platform: 'darwin', arch: 'arm64', archive: 'mac.tgz' },
  )

  assert.deepEqual(catalog.artifacts.map(({ platform, arch }) => `${platform}/${arch}`), [
    'darwin/arm64',
    'win32/x64',
  ])
})

test('does not enforce a 9.1-only session mutation contract in the 8.1 runtime builder', async () => {
  const source = await readFile(new URL('./build-openclaw-runtime-bundle.mjs', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /sessionsPatchModelAllowedBySource/)
  assert.doesNotMatch(source, /verifySessionsPatchModelScope/)
  assert.doesNotMatch(source, /OpenClaw 9\.1 contract drift/)
})

test('removes every leading stream-failure placeholder from the next agent prompt', () => {
  const source = 'function toPromptEntry(Ot){let Zt=safeBody(Ot.entry.body);return Ot.role===`assistant`&&Ot.internalStreamError===!0&&Zt.trim()===`[assistant turn failed before producing content]`?null:{...Ot.entry,body:Zt}}'
  const patched = scrubStreamFailureMarkersFromAgentPromptSource(source)

  assert.match(patched, /for\(;Ot\.role===`assistant`&&_n\.trimStart\(\)\.startsWith/)
  assert.equal(scrubStreamFailureMarkersFromAgentPromptSource(patched), patched)
  assert.throws(
    () => scrubStreamFailureMarkersFromAgentPromptSource('function toPromptEntry() {}'),
    /agent prompt fallback anchor/,
  )
})

test('keeps generated media in the transcript but removes it from model context replay', () => {
  const source = `if (block.type === "text") return sameModel ? block : {
\t\t\ttype: "text",
\t\t\ttext: block.text
\t\t};
\t\tconst { thoughtSignature: _, ...unsigned } = block;
\t\tconst trimmedId = block.id.trim();`
  const patched = scrubAssistantAttachmentsFromModelContextSource(source)

  assert.match(patched, /if \(block\.type !== "toolCall"\) return \[\];/)
  assert.match(patched, /typeof block\.id === "string" \? block\.id\.trim\(\) : ""/)
  assert.equal(scrubAssistantAttachmentsFromModelContextSource(patched), patched)
  assert.throws(
    () => scrubAssistantAttachmentsFromModelContextSource('function transformAssistant() {}'),
    /assistant attachment transformer anchor/,
  )
})

test('patches local media refs into the pinned OpenClaw 2026.8.1 runtime sources', async () => {
  const archive = new URL('../src-tauri/resources/uniopc-engine-runtime/uniopc-engine-runtime-darwin-x64.tar.gz', import.meta.url)
  const prefix = 'tools/node-v24.19.0/lib/node_modules/uniopc-engine/'
  const members = [
    `${prefix}package.json`,
    `${prefix}dist/src-CwDR-7yt.js`,
    `${prefix}dist/attachment-normalize-BA7mKleS.js`,
    `${prefix}dist/chat-attachments-PRJdGIAB.js`,
  ]
  const temp = mkdtempSync(join(tmpdir(), 'uniopc-openclaw-attachment-contract-'))
  try {
    execFileSync('tar', ['-xzf', archive.pathname, '-C', temp, ...members])
    const runtimeRoot = join(temp, prefix)
    const packageJson = JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8'))
    assert.equal(packageJson.version, '2026.8.1')

    const schemaPath = join(runtimeRoot, 'dist/src-CwDR-7yt.js')
    const normalizerPath = join(runtimeRoot, 'dist/attachment-normalize-BA7mKleS.js')
    const parserPath = join(runtimeRoot, 'dist/chat-attachments-PRJdGIAB.js')
    const schema = addLocalMediaIdToChatAttachmentSchema(readFileSync(schemaPath, 'utf8'))
    const normalizer = preserveLocalMediaIdInRpcAttachmentNormalizer(readFileSync(normalizerPath, 'utf8'))
    const parser = resolveTrustedLocalMediaInAttachmentParser(readFileSync(parserPath, 'utf8'))

    assert.match(schema, /localMediaId: Type\.Optional/)
    assert.match(normalizer, /a\?\.localMediaId/)
    assert.match(normalizer, /a\.localMediaId !== void 0/)
    assert.match(parser, /readMediaBuffer\(att\.localMediaId, "inbound", localMaxBytes\)/)
    assert.match(parser, /const localMaxBytes = 10 \* 1024 \* 1024/)
    assert.match(parser, /const attachmentMaxBytes = localMedia \? 10 \* 1024 \* 1024 : maxBytes/)
    assert.doesNotMatch(parser, /50 \* 1024 \* 1024|20 \* 1024 \* 1024/)
    assert.match(parser, /const imageMaxBytes = localMedia \? 10 \* 1024 \* 1024 : 6291456/)
    assert.match(parser, /invalid-local-media-ref/)
    assert.match(parser, /if \(!localMedia && !\(shouldForceImageOffload/)
    assert.equal(addLocalMediaIdToChatAttachmentSchema(schema), schema)
    assert.equal(preserveLocalMediaIdInRpcAttachmentNormalizer(normalizer), normalizer)
    assert.equal(resolveTrustedLocalMediaInAttachmentParser(parser), parser)

    // Execute the transformed 2026.8.1 parser function against a real local
    // media fixture. This checks the parser calls the guarded reader, consumes
    // those bytes, and forwards the managed path without saving a duplicate.
    const functionStart = parser.indexOf('async function parseMessageWithAttachments(')
    const functionEnd = parser.indexOf('\n}\n//#endregion', functionStart)
    assert.notEqual(functionStart, -1)
    assert.notEqual(functionEnd, -1)
    const parserFunctionSource = parser.slice(functionStart, functionEnd + 2)
    const mediaId = '0e3c9371-5c9e-4db3-9e74-79ac36b3b134'
    const inboundDir = join(temp, 'managed-media', 'inbound')
    mkdirSync(inboundDir, { recursive: true })
    const fixtureBytes = Buffer.from('text fixture read by patched parser', 'utf8')
    writeFileSync(join(inboundDir, mediaId), fixtureBytes)
    const mediaReads = []
    let duplicateSaveAttempted = false
    const parserDependencies = {
      normalizeAttachment: (attachment, index) => ({
        base64: String(attachment.content || '').trim(),
        label: attachment.fileName || attachment.type || `attachment-${index + 1}`,
        mime: attachment.mimeType || '',
      }),
      UnsupportedAttachmentError: class UnsupportedAttachmentError extends Error {},
      isValidAttachmentBase64: value => /^[A-Za-z0-9+/]*={0,2}$/.test(value),
      estimateBase64DecodedBytes: value => Buffer.from(value, 'base64').byteLength,
      normalizeMime: value => String(value || '').trim().toLowerCase(),
      sniffMimeFromBase64: async () => null,
      resolveAttachmentMime: ({ sniffedMime, providedMime, labelMime }) => sniffedMime || providedMime || labelMime,
      mimeTypeFromFilePath: value => String(value).endsWith('.txt') ? 'text/plain' : '',
      isGenericContainerMime: () => false,
      MAX_IMAGE_BYTES: 6 * 1024 * 1024,
      isImageMime: value => value.startsWith('image/'),
      TEXT_ONLY_OFFLOAD_LIMIT: 10,
      OFFLOAD_THRESHOLD_BYTES: 2 * 1024 * 1024,
      readMediaBuffer: async (id, subdir, maxBytes) => {
        mediaReads.push({ id, subdir, maxBytes })
        const buffer = readFileSync(join(temp, 'managed-media', subdir, id))
        assert.ok(buffer.byteLength <= maxBytes)
        return { id, path: join(temp, 'managed-media', subdir, id), buffer, size: buffer.byteLength }
      },
      verifyDecodedSize: (buffer, expectedSize) => assert.equal(buffer.byteLength, expectedSize),
      saveMediaBuffer: async () => {
        duplicateSaveAttempted = true
        throw new Error('local media must not be copied again')
      },
      assertSavedMedia: value => value,
      MediaOffloadError: class MediaOffloadError extends Error {},
      formatErrorMessage: error => String(error?.message || error),
      ensureExtension: value => value,
      buildManagedInboundMediaRef: id => `managed://inbound/${id}`,
      kindFromMime: () => 'document',
      deleteMediaBuffer: async () => {},
      enrichOffloadedMediaMetadata: async () => {},
      log: null,
    }
    const parseMessageWithAttachments = new Function(
      ...Object.keys(parserDependencies),
      `return (${parserFunctionSource})`,
    )(...Object.values(parserDependencies))
    const parsed = await parseMessageWithAttachments('Read this', [{
      type: 'file',
      mimeType: 'text/plain',
      fileName: 'notes.txt',
      localMediaId: mediaId,
      sizeBytes: fixtureBytes.byteLength,
    }], { maxBytes: 20 * 1024 * 1024 })
    assert.deepEqual(mediaReads, [{ id: mediaId, subdir: 'inbound', maxBytes: 10 * 1024 * 1024 }])
    assert.equal(duplicateSaveAttempted, false)
    assert.equal(parsed.offloadedRefs[0].path, join(temp, 'managed-media', 'inbound', mediaId))
    assert.equal(parsed.media[0].contentType, 'text/plain')
    assert.match(parsed.message, /\[media attached: managed:\/\/inbound\//)
    await assert.rejects(parseMessageWithAttachments('Read this', [{
      type: 'file',
      mimeType: 'text/plain',
      fileName: 'notes.txt',
      localMediaId: '../outside',
      sizeBytes: fixtureBytes.byteLength,
    }], { maxBytes: 20 * 1024 * 1024 }), /invalid-local-media-ref/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

// Verbatim 2026.8.1 native/cache routines from the installed runtime. Modules,
// dependencies and fallback factory below are real temporary test artifacts.
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
const nativeLoaderFixture = [
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
const cachedLoaderFixture = [
  "function createLazySourceTransformLoader(params) {",
  "\tlet loadWithSourceTransform;",
  "\treturn () => {",
  "\t\tif (loadWithSourceTransform) return loadWithSourceTransform;",
  "\t\tconst jitiOptions = buildPluginLoaderJitiOptions(params.getAliasMap(), { modulePath: params.loaderFilename });",
  "\t\tconst jitiLoader = (params.createLoader ?? loadCreateJitiLoaderFactory())(params.loaderFilename, {",
  "\t\t\t...jitiOptions,",
  "\t\t\tnativeModules: params.transformOpenClawDependencies ? jitiOptions.nativeModules.filter((moduleName) => moduleName !== \"openclaw\") : jitiOptions.nativeModules,",
  "\t\t\ttryNative: false",
  "\t\t});",
  "\t\tloadWithSourceTransform = (target) => jitiLoader(toSourceTransformImportPath(target));",
  "\t\treturn loadWithSourceTransform;",
  "\t};",
  "}",
  "function createPluginModuleLoader(params) {",
  "\tconst getLoadWithSourceTransform = createLazySourceTransformLoader({ ...params });",
  "\tconst loadCachedTarget = (target, load) => {",
  "\t\tconst source = getPluginCacheSource(target, params.cache);",
  "\t\tconst cached = source.variants.get(params.cacheKey)?.exports;",
  "\t\tif (cached) return cached.value;",
  "\t\tsource.boundaryRoot = params.rootDir ?? source.boundaryRoot ?? path.dirname(target.startsWith(\"file:\") ? fileURLToPath(target) : target);",
  "\t\tconst loaded = withPluginCache(params.cache, load);",
  "\t\tsource.variants.set(params.cacheKey, { exports: { value: loaded } });",
  "\t\treturn loaded;",
  "\t};",
  "\tif (!params.tryNative) return (target) => loadCachedTarget(target, () => {",
  "\t\tpluginModuleLoaderStats.calls += 1;",
  "\t\tpluginModuleLoaderStats.sourceTransformForced += 1;",
  "\t\trecordSourceTransformTarget(target);",
  "\t\treturn getLoadWithSourceTransform()(target);",
  "\t});",
  "\treturn (target) => loadCachedTarget(target, () => {",
  "\t\tpluginModuleLoaderStats.calls += 1;",
  "\t\tconst native = tryNativeRequireJavaScriptModule(target, {",
  "\t\t\tallowWindows: true,",
  "\t\t\taliasMap: params.resolveAlias,",
  "\t\t\tfallbackOnMissingDependency: true",
  "\t\t});",
  "\t\tif (native.ok) {",
  "\t\t\tpluginModuleLoaderStats.nativeHits += 1;",
  "\t\t\treturn native.moduleExport;",
  "\t\t}",
  "\t\tpluginModuleLoaderStats.nativeMisses += 1;",
  "\t\tpluginModuleLoaderStats.sourceTransformFallbacks += 1;",
  "\t\trecordSourceTransformTarget(target);",
  "\t\treturn getLoadWithSourceTransform()(target);",
  "\t});",
  "}"
].join('\n')
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
const workerCachedLoaderFixture = "function createLazySourceTransformLoader(Ot){let loadWithSourceTransform;return()=>{if(loadWithSourceTransform)return loadWithSourceTransform;let Zt=buildPluginLoaderJitiOptions(Ot.getAliasMap(),{modulePath:Ot.loaderFilename}),_n=(Ot.createLoader??loadCreateJitiLoaderFactory$1())(Ot.loaderFilename,{...Zt,nativeModules:Ot.transformOpenClawDependencies?Zt.nativeModules.filter(Ot=>Ot!==`openclaw`):Zt.nativeModules,tryNative:!1});return loadWithSourceTransform=Ot=>_n(toSourceTransformImportPath(Ot)),loadWithSourceTransform}}function createPluginModuleLoader$1(Ot){let Zt=createLazySourceTransformLoader({...Ot}),loadCachedTarget=(Zt,_n)=>{let Dn=getPluginCacheSource(Zt,Ot.cache),kn=Dn.variants.get(Ot.cacheKey)?.exports;if(kn)return kn.value;Dn.boundaryRoot=Ot.rootDir??Dn.boundaryRoot??path.dirname(Zt.startsWith(`file:`)?fileURLToPath(Zt):Zt);let Pn=withPluginCache(Ot.cache,_n);return Dn.variants.set(Ot.cacheKey,{exports:{value:Pn}}),Pn};return Ot.tryNative?_n=>loadCachedTarget(_n,()=>{pluginModuleLoaderStats.calls+=1;let Dn=tryNativeRequireJavaScriptModule(_n,{allowWindows:!0,aliasMap:Ot.resolveAlias,fallbackOnMissingDependency:!0});return Dn.ok?(pluginModuleLoaderStats.nativeHits+=1,Dn.moduleExport):(pluginModuleLoaderStats.nativeMisses+=1,pluginModuleLoaderStats.sourceTransformFallbacks+=1,recordSourceTransformTarget(_n),Zt()(_n))}):Ot=>loadCachedTarget(Ot,()=>(pluginModuleLoaderStats.calls+=1,pluginModuleLoaderStats.sourceTransformForced+=1,recordSourceTransformTarget(Ot),Zt()(Ot)))}"
async function nativeLoaderStage(t) {
  const prefix = realpathSync.native(mkdtempSync(join(tmpdir(), 'uniopc-native-loader-')))
  t.after(() => rmSync(prefix, { recursive: true, force: true }))
  const dist = join(prefix, 'tools/node/node_modules/uniopc-engine/dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, '../package.json'), JSON.stringify({ name: 'openclaw', type: 'module' }))
  const file = join(dist, 'loader-fixture.js')
  const prelude = `import Module, { createRequire, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';import path from 'node:path';
const isPathInside=(root,file)=>{const rel=path.relative(root,file);return rel!== '..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)};
`
  const cacheDependencies = `
const pluginModuleLoaderStats={calls:0,nativeHits:0,nativeMisses:0,sourceTransformForced:0,sourceTransformFallbacks:0};
function getPluginCacheSource(target,cache){const key=path.resolve(target.startsWith('file:')?fileURLToPath(target):target);let source=cache.sources.get(key);if(!source){source={variants:new Map()};cache.sources.set(key,source)}return source}
const withPluginCache=(cache,run)=>run();const recordSourceTransformTarget=()=>{};
const toSourceTransformImportPath=target=>target;
const buildPluginLoaderJitiOptions=alias=>({alias,nativeModules:['openclaw']});
const loadCreateJitiLoaderFactory=()=>{throw new Error('fixture requires explicit fallback factory')};
`
  writeFileSync(file, nativePrefixFixture + nativeLoaderFixture + '\n')
  const workerFile=join(dist,'worker/worker.mjs');mkdirSync(dirname(workerFile),{recursive:true})
  writeFileSync(workerFile,workerSource(false))
  await patchWindowsNativeModuleRequire(prefix)
  const patchedStage = readFileSync(file, 'utf8')
  const regionStart = patchedStage.indexOf('//#region src/plugins/native-module-require.ts')
  const executionRegion = patchedStage.slice(regionStart).trimEnd()
  assert.equal(executionRegion, nativeLoaderFixture.replace(WINDOWS_NATIVE_REQUIRE_ORIGINAL, WINDOWS_NATIVE_REQUIRE_PATCHED))
  // Runtime imports outside this region are intentionally absent in this tiny
  // fixture. Execute a separate harness with the exact verified patched region.
  const harness = join(prefix, 'execution-harness.mjs')
  writeFileSync(harness, prelude + executionRegion + cacheDependencies + cachedLoaderFixture
    + '\nexport {tryNativeRequireJavaScriptModule,clearPluginModuleRequireCache,withNativeRequireAliases,createPluginModuleLoader};')
  const loader = await import(pathToFileURL(harness).href)
  const workerStage=readFileSync(workerFile,'utf8')
  const workerRegion=workerStage.slice(workerStage.indexOf('function toSafeImportPath('),workerStage.indexOf('function readPackageName$2('))
  assert.equal(workerRegion,workerBlockFixture.replace(WINDOWS_WORKER_NATIVE_REQUIRE_ORIGINAL,WINDOWS_WORKER_NATIVE_REQUIRE_PATCHED))
  const workerHarness=join(prefix,'worker-execution-harness.mjs')
  writeFileSync(workerHarness,prelude+'const __esmMin=run=>run;const init_path_guards=()=>{};\n'+workerRegion+cacheDependencies+workerCachedLoaderFixture
    +'init_native_module_require();\nexport {tryNativeRequireJavaScriptModule,withNativeRequireAliases,createPluginModuleLoader$1 as createPluginModuleLoader,pluginModuleLoaderStats};')
  const workerLoader=await import(pathToFileURL(workerHarness).href)
  return { prefix, dist, file, loader, workerFile, workerLoader }
}

test('native loader patch is unique, idempotent and rejects missing or drifting staged helpers before writing', async t => {
  assert.ok(nativeLoaderFixture.includes(WINDOWS_NATIVE_REQUIRE_ORIGINAL), 'recorded upstream fixture must match the pinned shape')
  const {prefix,dist,file,workerFile}=await nativeLoaderStage(t)
  const workerPatched=readFileSync(workerFile,'utf8')
  const patched=readFileSync(file,'utf8')
  assert.ok(patched.includes(WINDOWS_NATIVE_REQUIRE_PATCHED))
  await patchWindowsNativeModuleRequire(prefix)
  assert.equal(readFileSync(file,'utf8'),patched)
  assert.equal(readFileSync(workerFile,'utf8'),workerPatched)
  // Role B drift must prevent even role A's original bytes being changed.
  writeFileSync(file,patched.replace(WINDOWS_NATIVE_REQUIRE_PATCHED,WINDOWS_NATIVE_REQUIRE_ORIGINAL))
  const originalMain=readFileSync(file,'utf8')
  for(const invalidWorker of [workerPatched.replace('Zt.aliasMap','Zt.changedAlias'),
    workerPrefixFixture+'\nfunction nested(){'+workerPatched.slice(workerPrefixFixture.length)+'}']) {
    writeFileSync(workerFile,invalidWorker)
    await assert.rejects(patchWindowsNativeModuleRequire(prefix),/worker.*drift/)
    assert.equal(readFileSync(file,'utf8'),originalMain)
  }
  writeFileSync(file,patched);writeFileSync(workerFile,workerPatched)
  const duplicate=join(dist,'second.mjs');writeFileSync(duplicate,patched)
  await assert.rejects(patchWindowsNativeModuleRequire(prefix),/exactly one(?: readable| worker)? helper/)
  assert.equal(readFileSync(file,'utf8'),patched)
  rmSync(duplicate)
  writeFileSync(file,patched.replace('options.allowWindows !== true','options.allowWindows !== false'))
  await assert.rejects(patchWindowsNativeModuleRequire(prefix),/structure drifted/)
  writeFileSync(file,'export const noHelper=true;')
  await assert.rejects(patchWindowsNativeModuleRequire(prefix),/exactly one(?: readable| worker)? helper/)
})

test('native loader loads real path/file URLs once, preserves special names and transitive CJS/ESM identity', async t => {
  const {dist,loader}=await nativeLoaderStage(t)
  const dependency=join(dist,'dependency.cjs');writeFileSync(dependency,'module.exports={value:42}')
  for(const extension of ['cjs','mjs']){
    const file=join(dist,`space 中文 # %.${extension}`)
    const key='native-'+dist+extension
    writeFileSync(file,extension==='cjs'
      ?`globalThis[${JSON.stringify(key)}]=(globalThis[${JSON.stringify(key)}]||0)+1;module.exports={dependency:require('./dependency.cjs')};`
      :`import dependency from './dependency.cjs';globalThis[${JSON.stringify(key)}]=(globalThis[${JSON.stringify(key)}]||0)+1;export {dependency};`)
    const byPath=loader.tryNativeRequireJavaScriptModule(file,{allowWindows:true})
    const byUrl=loader.tryNativeRequireJavaScriptModule(pathToFileURL(file).href,{allowWindows:true})
    assert.equal(byPath.ok,true);assert.equal(byUrl.moduleExport,byPath.moduleExport)
    const imported=await import(pathToFileURL(file).href)
    assert.equal(extension==='cjs'?imported.default:imported,byPath.moduleExport)
    assert.equal(byUrl.moduleExport.dependency.value,42);assert.equal(globalThis[key],1)
    delete globalThis[key]
  }
})

test('native loader rejects URL identity loss before extension/require or permissive fallback classification', async t => {
  const {dist,loader}=await nativeLoaderStage(t)
  const url=pathToFileURL(join(dist,'missing.cjs')).href
  for(const bad of [url+'?query',url+'?',url+'#fragment',url+'#',url.replace('missing','%2fmissing'),url.replace('missing','%5cmissing'),url.replace('missing','%ZZmissing')]){
    assert.throws(()=>loader.tryNativeRequireJavaScriptModule(bad,{allowWindows:true,fallbackOnNativeError:true}),/identity|encoded|URI|URL/i)
  }
})

test('native loader retains real errors, target/dependency fallback and top-level-await import fallback', async t => {
  const {dist,loader}=await nativeLoaderStage(t)
  const load=(file,options={})=>loader.tryNativeRequireJavaScriptModule(pathToFileURL(file).href,{allowWindows:true,...options})
  assert.deepEqual(load(join(dist,'absent.cjs')),{ok:false})
  const missing=join(dist,'missing-dependency.cjs');writeFileSync(missing,"require('uniopc-nonexistent-transitive-fixture')")
  assert.throws(()=>load(missing),error=>error.code==='MODULE_NOT_FOUND'&&error.message.includes('uniopc-nonexistent-transitive-fixture'))
  assert.deepEqual(load(missing,{fallbackOnMissingDependency:true}),{ok:false})
  const failure=join(dist,'failure.cjs');writeFileSync(failure,"throw new Error('real-fixture-error')")
  assert.throws(()=>load(failure),/real-fixture-error/)
  assert.deepEqual(load(failure,{fallbackOnNativeError:true}),{ok:false})
  const tla=join(dist,'tla.mjs');writeFileSync(tla,'await Promise.resolve();export const value=17')
  assert.deepEqual(load(tla),{ok:false})
  assert.equal((await import(pathToFileURL(tla).href)).value,17)
})

test('native loader alias hooks restore on success/error and mixed fallback shares one SDK and cache generation', async t => {
  const {dist,loader}=await nativeLoaderStage(t)
  const sdk=join(dist,'sdk.cjs'),native=join(dist,'native.cjs'),fallback=join(dist,'fallback.cts')
  const key='sdk-'+dist;globalThis[key]={evaluations:0,registrations:0}
  writeFileSync(sdk,`globalThis[${JSON.stringify(key)}].evaluations++;const registrations=new Set();module.exports={register(id){if(!registrations.has(id)){registrations.add(id);globalThis[${JSON.stringify(key)}].registrations++}},registrations};`)
  writeFileSync(native,"const sdk=require('fixture-sdk');sdk.register('shared');module.exports={sdk};")
  writeFileSync(fallback,"const sdk: any=require('fixture-sdk');sdk.register('shared');module.exports={sdk};")
  const aliases={'fixture-sdk':sdk};const original=Module._resolveFilename
  const first=loader.tryNativeRequireJavaScriptModule(pathToFileURL(native).href,{allowWindows:true,aliasMap:aliases})
  assert.equal(first.ok,true);assert.equal(Module._resolveFilename,original)
  const esmAlias=join(dist,'alias-esm.mjs');writeFileSync(esmAlias,"import sdk from 'fixture-sdk';export {sdk};")
  assert.equal(loader.tryNativeRequireJavaScriptModule(pathToFileURL(esmAlias).href,{allowWindows:true,aliasMap:aliases}).moduleExport.sdk,first.moduleExport.sdk)
  const resolverFailure=join(dist,'resolver-error.cjs');writeFileSync(resolverFailure,"require('fixture-sdk')")
  assert.throws(()=>loader.tryNativeRequireJavaScriptModule(resolverFailure,{allowWindows:true,aliasMap:()=>{throw new Error('resolver-failure')}}),/resolver-failure/)
  assert.equal(Module._resolveFilename,original)

  const errorFile=join(dist,'alias-error.cjs');writeFileSync(errorFile,"require('fixture-sdk');throw new Error('alias-failure')")
  assert.throws(()=>loader.tryNativeRequireJavaScriptModule(errorFile,{allowWindows:true,aliasMap:aliases}),/alias-failure/)
  assert.equal(Module._resolveFilename,original)
  assert.throws(()=>createRequire(import.meta.url)('fixture-sdk'),/Cannot find module/)
  const requireFixture=createRequire(pathToFileURL(join(dist,'entry.cjs')))
  let factories=0,fallbackCalls=0
  const params={cache:{sources:new Map()},cacheKey:'generation-1',rootDir:dist,loaderFilename:native,
    getAliasMap:()=>aliases,resolveAlias:specifier=>aliases[specifier],tryNative:true,transformOpenClawDependencies:true,
    createLoader:(filename,options)=>{factories++;assert.equal(options.tryNative,false);assert.deepEqual(options.nativeModules,[]);
      return target=>{fallbackCalls++;
        const transformed=new Module(target);transformed.filename=target;transformed.paths=Module._nodeModulePaths(dirname(target));
        requireFixture.cache[target]=transformed;
        try{return loader.withNativeRequireAliases(options.alias,()=>{
          transformed._compile(stripTypeScriptTypes(readFileSync(target,'utf8')),target);transformed.loaded=true;return transformed.exports;
        })}catch(error){delete requireFixture.cache[target];throw error}
      }}
  }
  const cached=loader.createPluginModuleLoader(params)
  const second=cached(fallback)
  assert.equal(second.sdk,first.moduleExport.sdk)
  assert.equal(cached(pathToFileURL(fallback).href),second)
  assert.equal(cached(native),first.moduleExport)
  assert.deepEqual(globalThis[key],{evaluations:1,registrations:1})
  assert.equal(factories,1);assert.equal(fallbackCalls,1)
  // Retiring the generation clears the native dependency subtree before reload.
  loader.clearPluginModuleRequireCache(native,{dependencyRoot:dist})
  loader.clearPluginModuleRequireCache(fallback,{dependencyRoot:dist})
  const next=loader.createPluginModuleLoader({...params,cache:{sources:new Map()},cacheKey:'generation-2'})
  const reloaded=next(native)
  assert.notEqual(reloaded.sdk,second.sdk)
  assert.deepEqual(globalThis[key],{evaluations:2,registrations:2})
  assert.equal(Module._resolveFilename,original)
  delete globalThis[key]
})

test('worker native loader records native hits without fallback and preserves real module, URL, alias and error behavior', async t => {
  const {dist,workerLoader:loader}=await nativeLoaderStage(t)
  const sdk=join(dist,'worker-sdk.cjs'),file=join(dist,'worker 中文 # %.cjs')
  const key='worker-'+dist;globalThis[key]={evaluations:0,registrations:0}
  writeFileSync(sdk,`globalThis[${JSON.stringify(key)}].evaluations++;module.exports={registered:false,register(){if(!this.registered){this.registered=true;globalThis[${JSON.stringify(key)}].registrations++}}}`)
  writeFileSync(file,"const sdk=require('worker-fixture-sdk');sdk.register();module.exports={sdk};")
  const aliases={'worker-fixture-sdk':sdk};let fallbacks=0
  const load=loader.createPluginModuleLoader({cache:{sources:new Map()},cacheKey:'worker-generation',rootDir:dist,
    loaderFilename:file,tryNative:true,getAliasMap:()=>aliases,resolveAlias:specifier=>aliases[specifier],
    createLoader:()=>{fallbacks++;throw new Error('unexpected worker fallback')}})
  const first=load(file);assert.equal(load(pathToFileURL(file).href),first)
  assert.deepEqual(globalThis[key],{evaluations:1,registrations:1});assert.equal(loader.pluginModuleLoaderStats.nativeHits,1);assert.equal(fallbacks,0)
  const esm=join(dist,'worker-esm.mjs');writeFileSync(esm,"import sdk from 'worker-fixture-sdk';export {sdk};")
  assert.equal(load(pathToFileURL(esm).href).sdk,first.sdk)
  assert.equal(loader.pluginModuleLoaderStats.nativeHits,2);assert.equal(loader.pluginModuleLoaderStats.sourceTransformFallbacks,0)
  const original=Module._resolveFilename
  const bad=join(dist,'worker-bad.cjs');writeFileSync(bad,"require('worker-fixture-sdk');throw new Error('worker-real-error')")
  assert.throws(()=>load(pathToFileURL(bad).href),/worker-real-error/);assert.equal(Module._resolveFilename,original)
  assert.throws(()=>createRequire(import.meta.url)('worker-fixture-sdk'),/Cannot find module/)
  for(const target of [pathToFileURL(file).href+'?',pathToFileURL(file).href+'#fragment',pathToFileURL(file).href.replace('worker%20','%2fworker%20'),pathToFileURL(file).href.replace('worker%20','%ZZworker%20')])
    assert.throws(()=>loader.tryNativeRequireJavaScriptModule(target,{allowWindows:true,fallbackOnNativeError:true}),/identity|URI|URL|encoded/i)
  assert.deepEqual(loader.tryNativeRequireJavaScriptModule(pathToFileURL(join(dist,'absent.cjs')).href,{allowWindows:true}),{ok:false})
  const missing=join(dist,'worker-missing.cjs');writeFileSync(missing,"require('missing-worker-dependency')")
  assert.throws(()=>loader.tryNativeRequireJavaScriptModule(missing,{allowWindows:true}),error=>error.code==='MODULE_NOT_FOUND')
  assert.deepEqual(loader.tryNativeRequireJavaScriptModule(missing,{allowWindows:true,fallbackOnMissingDependency:true}),{ok:false})
  const tla=join(dist,'worker-tla.mjs');writeFileSync(tla,'await Promise.resolve();export const value=23')
  assert.deepEqual(loader.tryNativeRequireJavaScriptModule(pathToFileURL(tla).href,{allowWindows:true}),{ok:false})
  assert.equal((await import(pathToFileURL(tla).href)).value,23)
  delete globalThis[key]
})
