import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('conversation voice input uses native Uniopc 引擎-style Tauri speech commands', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.equal(source.includes('window.SpeechRecognition'), false)
  assert.equal(source.includes('window.webkitSpeechRecognition'), false)
  assert.match(source, /invoke\('native_voice_input_start'/)
  assert.match(source, /invoke\('native_voice_input_stop'/)
  assert.match(source, /invoke\('native_voice_input_cancel'/)
  assert.match(source, /listen\('native-voice-input-event'/)
})

test('conversation native voice events append final transcript and keep partial state separate', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.match(source, /nativeVoicePartial/)
  assert.match(source, /setNativeVoicePartial/)
  assert.match(source, /status === 'partial'/)
  assert.match(source, /status === 'final'/)
  assert.match(source, /appendVoiceTranscript/)
})

test('non-macOS dictation falls back to the cloud transcribe pipeline instead of native speech', () => {
  const source = read('src/pages/Conversations.jsx')

  // 平台分流:macOS 走 native,其余走 webview 录音 + 云端 transcribe。
  assert.match(source, /NATIVE_VOICE_INPUT_PLATFORM/)
  assert.match(source, /startAudioRecording/)
  assert.match(source, /transcribeDictationBlob\(supabase/)
  assert.match(source, /voiceProcessing/)
  // 「去本机权限」CTA 只在 macOS 出现(那页是 TCC 专属)。
  assert.match(source, /nativeVoiceError && NATIVE_VOICE_INPUT_PLATFORM/)

  const dictation = read('src/lib/voiceDictation.js')
  // 聊天听写的口径:关说话人分离、转完即删,不在录音转写列表留痕。
  assert.match(dictation, /diarizationEnabled: false/)
  assert.match(dictation, /deleteTranscription/)

  // 「本机权限」入口在非 macOS 隐藏,而不是渲染一页禁用按钮。
  const settings = read('src/pages/Settings.jsx')
  assert.match(settings, /HOST_PERMISSIONS_SUPPORTED/)
  assert.equal(settings.includes("{ id: 'host-permissions', label: '本机权限', route: 'host-permissions' }"), true)
})

test('conversation native voice errors explain macOS app bundle and privacy permission failures', () => {
  const source = read('src/pages/Conversations.jsx')

  assert.match(source, /formatNativeVoiceInputError/)
  assert.match(source, /isNativeVoiceInputError/)
  assert.match(source, /打包后的 Uniopc\.app/)
  assert.match(source, /系统设置里允许 Uniopc 使用麦克风/)
  assert.match(source, /系统设置里允许 Uniopc 使用语音识别/)
  assert.match(source, /语音输入不可用/)
  assert.match(source, /本机权限/)
  assert.match(source, /host-permissions/)
})
