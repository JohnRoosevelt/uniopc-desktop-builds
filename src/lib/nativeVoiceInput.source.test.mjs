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

test('native voice input commands are registered with Tauri', () => {
  const lib = read('src-tauri/src/lib.rs')
  const commands = read('src-tauri/src/commands/mod.rs')

  assert.match(commands, /pub mod native_voice_input;/)
  for (const command of [
    'native_voice_input_start',
    'native_voice_input_stop',
    'native_voice_input_cancel',
  ]) {
    assert.match(lib, new RegExp(`commands::native_voice_input::${command}`))
  }
})

test('native voice input service follows the Uniopc 引擎 macOS speech pipeline', () => {
  const service = read('src-tauri/src/services/native_voice_input.rs')

  for (const phrase of [
    'AVAudioEngine',
    'SFSpeechRecognizer',
    'SFSpeechAudioBufferRecognitionRequest',
    'installTapOnBus:bufferSize:format:block:',
    'recognitionTaskWithRequest:resultHandler:',
    'native-voice-input-event',
  ]) {
    assert.match(service, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  assert.match(service, /#\[link\(name = "AVFoundation", kind = "framework"\)\]/)
  assert.match(service, /#\[link\(name = "Speech", kind = "framework"\)\]/)
})

test('native voice input guards TCC speech APIs when running outside a macOS app bundle', () => {
  const service = read('src-tauri/src/services/native_voice_input.rs')
  const guardIndex = service.indexOf('ensure_tcc_usage_descriptions_are_available()?')
  const permissionIndex = service.indexOf('ensure_permissions()?')
  const speechIndex = service.indexOf('SFSpeechRecognizer')

  assert.ok(guardIndex > -1, 'native voice start should guard the runtime before touching TCC APIs')
  assert.ok(permissionIndex > -1, 'native voice start should still request permissions after the guard')
  assert.ok(guardIndex < permissionIndex, 'TCC guard must run before permission checks')
  assert.ok(guardIndex < speechIndex, 'TCC guard must run before SFSpeechRecognizer usage')
  assert.match(service, /code_signature_binds_info_plist/)
  assert.match(service, /NSSpeechRecognitionUsageDescription/)
  assert.match(service, /NSMicrophoneUsageDescription/)
})
