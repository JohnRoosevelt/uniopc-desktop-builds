import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('private conversion desktop exposes native article management', () => {
  const page = read('src/pages/apps/PrivateConversionApp.jsx')
  const backend = read('src/lib/appsBackend.js')
  assert.match(page, /\{ key: 'article', label: '文章' \}/)
  assert.match(page, /function publishArticle\(/)
  assert.match(page, /operator_publish_article/)
  assert.match(page, /article_publish_verification_failed/)
  assert.match(backend, /EMPTY_ARTICLE_FORM/)
  assert.match(backend, /postType: post\.post_type \|\| post\.postType \|\| 'video'/)
})
