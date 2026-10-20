import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const documents = readFileSync(resolve(srcDir, 'pages/CloudDocuments.jsx'), 'utf8')
const editor = readFileSync(resolve(srcDir, 'components/CloudBlockSuiteEditor.jsx'), 'utf8')

assert.match(documents, /<CloudBlockSuiteEditor/)
assert.match(documents, /documentTitleFromMarkdown\(markdownProjection,/)
assert.equal(documents.includes('project_id'), false)
assert.match(editor, /cloudDocCrdtBodyDecodes/)
