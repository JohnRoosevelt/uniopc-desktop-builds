import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'CloudDocuments.jsx'), 'utf8')

test('documents use the fixed local client without browser cloud CRUD', () => {
  assert.match(source, /from ['"]\.\.\/lib\/localDocuments['"]/)
  assert.match(source, /listLocalDocuments\(/)
  assert.match(source, /getLocalDocument\(/)
  assert.match(source, /createLocalDocument\(/)
  assert.match(source, /updateLocalDocument\(/)
  assert.match(source, /archiveLocalDocument\(/)
  assert.equal(source.includes("from '../lib/supabase'"), false)
  assert.equal(source.includes("from '../hooks/useAuth'"), false)
  assert.equal(source.includes('listCloudDocuments'), false)
  assert.equal(source.includes('createCloudDocument'), false)
  assert.equal(source.includes('updateCloudDocument'), false)
  assert.equal(source.includes('deleteCloudDocument'), false)
  assert.equal(source.includes('listCloudDocumentCategories'), false)
  assert.match(source, /我的文档/)
  assert.match(source, /本地/)
  assert.equal(source.includes('项目成员'), false)
  assert.equal(source.includes('归属项目'), false)
  assert.equal(source.includes('project_id'), false)
  assert.equal(source.includes('cloud_document_acl'), false)
})

test('documents wait for and pin the active workspace profile before local storage access', () => {
  assert.match(source, /useActiveOpenClawProfile/)
  assert.match(source, /useProfileWorkspace/)
  assert.match(source, /const activeProfile = profileWorkspace \? profileWorkspace\.activeProfile : activeOpenClaw\.activeProfile \|\| ''/)
  assert.match(source, /if \(activeOpenClaw\.loading \|\| !activeProfile\) return/)
  assert.match(source, /listLocalDocuments\(category, \{ profile: activeProfile \}\)/)
  assert.match(source, /getLocalDocument\(documentId, \{ profile: activeProfile \}\)/)
  assert.match(source, /profile: activeProfile,/)
})

test('documents launch the global session instead of mounting VoiceToDocumentPanel', () => {
  assert.match(source, /useVoiceToDocumentSession/)
  assert.match(source, /openVoiceToDocument\(\)/)
  assert.equal(source.includes('<VoiceToDocumentPanel'), false)
  assert.equal(source.includes('createFromTranscript'), false)
  assert.equal(source.includes('onComplete={'), false)
})

test('personal documents retain BlockSuite workflows', () => {
  assert.match(source, /<CloudBlockSuiteEditor/)
})

test('a new blank document waits for its CRDT body before mounting BlockSuite', () => {
  assert.match(source, /initializingBlankDraft/)
  assert.match(source, /正在初始化文档编辑器/)
  assert.match(source, /setInitializingBlankDraft\(true\)/)
  assert.match(source, /setInitializingBlankDraft\(false\)/)
})

test('document list refreshes when recording creates a document in the active profile', () => {
  assert.match(source, /uniopc:local-documents-changed/)
  assert.match(source, /window\.addEventListener/)
  assert.match(source, /profile === activeProfile/)
})
