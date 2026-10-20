import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, 'PrivateConversionApp.jsx'),
  'utf8',
)

test('channel profile image controls use mounted file inputs for the Tauri file picker', () => {
  assert.match(source, /const profileImageInputRef = useRef\(null\)/)
  assert.match(source, /<input ref=\{profileImageInputRef\} type="file" accept="image\/\*" className="hidden" onChange=\{onProfileImagePicked\} \/>/)
  assert.match(source, /profileImageInputRef\.current/)
  assert.match(source, /input\.click\(\)/)
  assert.doesNotMatch(source, /document\.createElement\('input'\)/)
})

test('video publishing controls use mounted file inputs for the Tauri file picker', () => {
  assert.match(source, /const videoFileInputRef = useRef\(null\)/)
  assert.match(source, /const videoCoverInputRef = useRef\(null\)/)
  assert.match(source, /<input ref=\{videoFileInputRef\} type="file" accept="video\/\*" className="hidden" onChange=\{onVideoFilePicked\} \/>/)
  assert.match(source, /<input ref=\{videoCoverInputRef\} type="file" accept="image\/\*" className="hidden" onChange=\{onVideoCoverPicked\} \/>/)
  assert.match(source, /onClick=\{pickVideoFile\}/)
  assert.match(source, /onClick=\{pickVideoCover\}/)
  assert.doesNotMatch(source, /pickFile\(/)
})

test('private conversion workspace lists channels through the Plugins action instead of the Server Base RPC', () => {
  assert.match(source, /callPrivateConversion\('operator_list_org_channels', \{ channelType: 'video' \}\)/)
  assert.doesNotMatch(source, /list_private_conversion_operator_channels/)
})
