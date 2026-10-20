import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const source = read('src/pages/apps/PrivateConversionApp.jsx')
const modalSource = read('src/components/Modal.jsx')
const appsUiSource = read('src/components/AppsUI.jsx')

test('private conversion desktop generates and downloads content QR codes', () => {
  assert.match(source, /operator_generate_content_qrcode/)
  assert.match(source, /contentType: target\.contentType/)
  assert.match(source, /channelId: target\.channelId/)
  assert.match(source, /postId: target\.postId/)
  assert.match(source, /liveSessionId: target\.liveSessionId/)
  assert.match(source, /qrCodeDataUrl/)
  assert.match(source, /生成二维码/)
  assert.match(source, /下载二维码/)
  assert.match(source, /\^data:image\\\/\(\?:png\|jpeg\);base64,/)
  assert.match(source, /data:image\\\/jpeg/)
  assert.match(source, /<img src=\{qrCodeDataUrl\}/)
  assert.match(source, /anchor\.download/)
  assert.match(source, /liveSessions\.filter\(item => item\.channelId === channelId\)/)
  assert.match(source, /const qrRequestRef = useRef\(false\)/)
  assert.match(source, /if \(qrRequestRef\.current \|\| !target\?\.contentType\) return/)
  assert.match(source, /qrRequestRef\.current = true/)
  assert.match(source, /qrRequestRef\.current = false/)
  assert.match(source, /qrRequestRef\.current = true\s*\n\s*setMoreActionsPost\(null\)\s*\n\s*setQrLoading\(true\)/)
  assert.match(source, /loading=\{qrLoading\}/)
  assert.match(modalSource, /role="dialog"/)
  assert.match(modalSource, /aria-modal="true"/)
  assert.match(modalSource, /aria-labelledby=/)
  assert.match(modalSource, /const dialog = dialogRef\.current/)
  assert.match(modalSource, /\(focusable\[0\] \|\| dialog\)\.focus\(\)/)
  assert.match(modalSource, /e\.key !== 'Tab'/)
  assert.match(modalSource, /!dialog\.contains\(document\.activeElement\)/)
  assert.match(modalSource, /e\.shiftKey \? last : first/)
  assert.match(appsUiSource, /role=\{tone === 'error' \? 'alert' : 'status'\}/)
  assert.match(appsUiSource, /aria-live=\{tone === 'error' \? 'assertive' : 'polite'\}/)
})

test('private conversion desktop can generate a one-time WeChat organization binding QR code', () => {
  assert.match(source, /operator_generate_wechat_binding_qrcode/)
  assert.match(source, /绑定微信/)
  assert.match(source, /微信绑定二维码/)
  assert.match(source, /expiresAt/)
  assert.match(source, /qrBindingCodeDataUrl/)
  assert.match(source, /envVersion: 'release'/)
  assert.doesNotMatch(source, /qrEnvVersion/)
})
