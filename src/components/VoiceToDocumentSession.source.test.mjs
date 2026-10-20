import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('global voice session is mounted under Layout and owns local transcript saving', () => {
  const source = read('src/components/VoiceToDocumentSession.jsx')
  const layout = read('src/components/Layout.jsx')

  assert.match(source, /export function VoiceToDocumentSessionProvider/)
  assert.match(source, /useVoiceToDocumentSession/)
  assert.match(source, /createLocalDocument\(/)
  assert.match(source, /createCloudCrdtDocumentFromMarkdown/)
  assert.match(source, /documentTitleFromMarkdown\(converted\.markdown, title\)/)
  assert.match(source, /TRANSCRIPTION_JOB_METADATA_KEY/)
  assert.match(source, /useActiveOpenClawProfile/)
  assert.match(source, /useProfileWorkspace/)
  assert.match(layout, /<VoiceToDocumentSessionProvider>/)
})

test('the global session keeps its panel mounted and can open a profile-aware completed document', () => {
  const source = read('src/components/VoiceToDocumentSession.jsx')

  assert.match(source, /sessionOpen/)
  assert.match(source, /minimized/)
  assert.match(source, /completedDocument/)
  assert.match(source, /<VoiceToDocumentPanel/)
  assert.match(source, /minimized=\{minimized\}/)
  assert.match(source, /onMinimize=\{\(\) => setMinimized\(true\)\}/)
  assert.match(source, /onExpand=\{\(\) => setMinimized\(false\)\}/)
  assert.match(source, /文档已生成/)
  assert.match(source, /cloud-documents/)
  assert.match(source, /useVoiceToDocumentSession must be used within VoiceToDocumentSessionProvider/)
})

test('the always-mounted voice session only loads BlockSuite when saving a transcript', () => {
  const source = read('src/components/VoiceToDocumentSession.jsx')
  assert.doesNotMatch(source, /import\s*\{[^}]*\}\s*from ['"]\.\.\/lib\/cloudBlocksuite['"]/)
  assert.match(source, /handleTranscriptComplete = useCallback\(async[\s\S]*await import\('\.\.\/lib\/cloudBlocksuite'\)[\s\S]*createCloudCrdtDocumentFromMarkdown\(markdown, title\)/)
})

test('completed recordings notify an already-mounted document list', () => {
  const source = read('src/components/VoiceToDocumentSession.jsx')
  assert.match(source, /uniopc:local-documents-changed/)
  assert.match(source, /documentId: created\.id/)
})
