import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./appsBackend.js', import.meta.url), 'utf8')
const transport = await readFile(new URL('./privateConversionService.js', import.meta.url), 'utf8')

test('private analytics fall back to Plugins actions rather than Server Base video RPCs', () => {
  assert.doesNotMatch(source, /list_cloud_workspace_video_comments/)
  assert.doesNotMatch(source, /list_cloud_workspace_video_interactions/)
  assert.match(source, /callPrivateConversion\('operator_list_comments'/)
  assert.match(source, /callPrivateConversion\('operator_list_post_interactions'/)
})

test('Socials routes the three public-traffic apps through the Plugins gateway', () => {
  assert.match(transport, /callSocials\(action, payload = \{\}\) \{\s*return request\('socials', \{ action, payload \}\)/)
  assert.match(source, /callPluginsSocials\(action, payload\)/)
  assert.doesNotMatch(source, /callSupabaseFunction\('socials'/)
})

test('Super IP routes the Desktop digital-human app through the Plugins gateway', () => {
  assert.match(transport, /callSuperIp\(action, payload = \{\}\) \{\s*return request\('super-ip', \{ action, payload \}\)/)
  assert.match(source, /callPluginsSuperIp\(action, payload\)/)
  assert.doesNotMatch(source, /callSupabaseFunction\('super-ip'/)
})
