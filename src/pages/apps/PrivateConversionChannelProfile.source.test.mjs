import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const page = fs.readFileSync(path.resolve(import.meta.dirname, 'PrivateConversionApp.jsx'), 'utf8')
const backend = fs.readFileSync(path.resolve(import.meta.dirname, '../../lib/appsBackend.js'), 'utf8')

test('desktop channel profile removes account category and saves contact information', () => {
  assert.doesNotMatch(page, /账号类型/)
  assert.doesNotMatch(page, /CHANNEL_CATEGORY_OPTIONS/)
  assert.doesNotMatch(page, /categoryLabel/)
  assert.match(page, /<Field label="联系方式">/)
  assert.match(page, /setProfileField\('contactText', e\.target\.value\)/)
  assert.doesNotMatch(backend, /CHANNEL_CATEGORY_OPTIONS/)
  assert.doesNotMatch(backend, /category:\s*form\.category/)
  assert.match(backend, /contactText:\s*form\.contactText/)
})
