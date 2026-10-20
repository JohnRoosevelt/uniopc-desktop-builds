import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUDIO_CONSTRAINTS,
  PREFERRED_AUDIO_MIME_TYPES,
  contentTypeFromMimeType,
  formatRecordingClock,
  isRecordingSupported,
  pickRecorderMimeType,
  startAudioRecording,
} from './audioRecorder.js'

test('说话人分离要求单声道 —— 这是整条链路的源头,不能改', () => {
  assert.equal(AUDIO_CONSTRAINTS.channelCount, 1)
})

test('Windows/WebView2 选 opus', () => {
  const supported = new Set(['audio/webm;codecs=opus', 'audio/webm'])
  assert.equal(pickRecorderMimeType(type => supported.has(type)), 'audio/webm;codecs=opus')
})

test('macOS/WKWebView 不支持 webm,回落到 mp4', () => {
  // Safari 只写 audio/mp4(AAC),webm 和 opus 一律不支持。
  const supported = new Set(['audio/mp4'])
  assert.equal(pickRecorderMimeType(type => supported.has(type)), 'audio/mp4')
})

test('都不支持时返回空串,交给浏览器默认值而不是硬塞', () => {
  assert.equal(pickRecorderMimeType(() => false), '')
})

test('isTypeSupported 缺失或抛错都不会把录音打死', () => {
  assert.equal(pickRecorderMimeType(undefined), '')
  assert.equal(
    pickRecorderMimeType(type => {
      if (type.includes('webm')) throw new TypeError('bad mime')
      return type === 'audio/mp4'
    }),
    'audio/mp4',
  )
})

test('候选列表覆盖两个平台各自的唯一可用格式', () => {
  assert.ok(PREFERRED_AUDIO_MIME_TYPES.some(type => type.startsWith('audio/webm')))
  assert.ok(PREFERRED_AUDIO_MIME_TYPES.some(type => type.startsWith('audio/mp4')))
})

test('contentType 剥掉 codecs —— 存储桶的 allowed_mime_types 只认基础类型', () => {
  assert.equal(contentTypeFromMimeType('audio/webm;codecs=opus'), 'audio/webm')
  assert.equal(contentTypeFromMimeType('audio/mp4;codecs=mp4a.40.2'), 'audio/mp4')
  assert.equal(contentTypeFromMimeType(''), 'audio/mp4')
  assert.equal(contentTypeFromMimeType(null, 'audio/webm'), 'audio/webm')
})

test('录音计时超过一小时才显示小时位', () => {
  assert.equal(formatRecordingClock(0), '00:00')
  assert.equal(formatRecordingClock(65_000), '01:05')
  assert.equal(formatRecordingClock(3_723_000), '1:02:03')
})

test('缺麦克风接口或 MediaRecorder 时如实报不支持', () => {
  assert.equal(isRecordingSupported({ mediaDevices: null, MediaRecorderCtor: null }), false)
  assert.equal(isRecordingSupported({ mediaDevices: {}, MediaRecorderCtor: function () {} }), false)
  assert.equal(
    isRecordingSupported({ mediaDevices: { getUserMedia() {} }, MediaRecorderCtor: function () {} }),
    true,
  )
})

// --- 录音控制器 ---

function fakeRecorderEnvironment({ supported = ['audio/webm;codecs=opus'] } = {}) {
  const stopped = []
  const stream = {
    getTracks: () => [{ stop: () => stopped.push('track') }],
  }
  const requested = []
  const mediaDevices = {
    getUserMedia(constraints) {
      requested.push(constraints)
      return Promise.resolve(stream)
    },
  }

  class FakeRecorder {
    static isTypeSupported(type) {
      return supported.includes(type)
    }

    constructor(_stream, options) {
      this.mimeType = options?.mimeType || ''
      this.state = 'inactive'
    }

    start() {
      this.state = 'recording'
    }

    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: { size: 4 } })
      this.onstop?.()
    }
  }

  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts
      this.type = options?.type || ''
      this.size = parts.length
    }
  }

  let clock = 1000
  return {
    stopped,
    requested,
    deps: {
      mediaDevices,
      MediaRecorderCtor: FakeRecorder,
      BlobCtor: FakeBlob,
      now: () => clock,
    },
    advance(ms) {
      clock += ms
    },
  }
}

test('起录时把单声道约束真的传给 getUserMedia', async () => {
  const env = fakeRecorderEnvironment()
  const controller = await startAudioRecording(env.deps)

  assert.equal(env.requested.length, 1)
  assert.equal(env.requested[0].audio.channelCount, 1)
  assert.equal(env.requested[0].video, false)
  assert.equal(controller.state, 'recording')
})

test('停止后给出 blob、基础 contentType 和时长', async () => {
  const env = fakeRecorderEnvironment()
  const controller = await startAudioRecording(env.deps)
  env.advance(4200)

  const result = await controller.stop()
  assert.equal(result.contentType, 'audio/webm')
  assert.equal(result.durationMs, 4200)
  assert.equal(result.blob.type, 'audio/webm')
  // 麦克风必须释放,否则系统状态栏的录音指示会一直亮着。
  assert.deepEqual(env.stopped, ['track'])
})

test('重复停止会被拒绝,不会重复上传', async () => {
  const env = fakeRecorderEnvironment()
  const controller = await startAudioRecording(env.deps)
  await controller.stop()
  await assert.rejects(() => controller.stop(), /录音已经停止/)
})

test('取消同样释放麦克风', async () => {
  const env = fakeRecorderEnvironment()
  const controller = await startAudioRecording(env.deps)
  controller.cancel()
  assert.deepEqual(env.stopped, ['track'])
})
