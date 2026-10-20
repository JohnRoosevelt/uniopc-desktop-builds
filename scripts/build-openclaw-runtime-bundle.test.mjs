import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  isMachOMagic,
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
