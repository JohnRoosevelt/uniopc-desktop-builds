import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTranscriptionUpload,
  documentTitleFromTranscript,
  freshAccessToken,
  isTerminalTranscriptionStatus,
  loadTranscriptionAudioUrl,
  speakerNamesFromDraft,
  transcriptionPollDelayMs,
  transcriptionJobIdOfDocument,
  transcriptionStatusLabel,
  updateTranscriptionSpeakers,
  uploadTranscriptionAudio,
  waitForTranscription,
} from './voiceTranscription.js'

function fakeClient({ invoke, upload } = {}) {
  const calls = []
  return {
    calls,
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'token-1' } } }),
    },
    functions: {
      invoke: async (name, options) => {
        calls.push({ name, ...options })
        return invoke ? invoke(name, options) : { data: { ok: true }, error: null }
      },
    },
    storage: {
      from(bucket) {
        return {
          upload: async (path, blob, options) => {
            calls.push({ bucket, path, blob, options })
            return upload ? upload() : { data: {}, error: null }
          },
        }
      },
    },
  }
}

test('令牌还新鲜时不去续期', async () => {
  const client = fakeClient()
  let refreshed = 0
  client.auth.getSession = async () => ({
    data: { session: { access_token: 'fresh', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
  })
  client.auth.refreshSession = async () => { refreshed += 1; return { data: { session: { access_token: 'new' } } } }
  assert.equal(await freshAccessToken(client), 'fresh')
  assert.equal(refreshed, 0)
})

test('令牌临期先续期 —— 录一小时的会议,拿到手的 token 正好过期', async () => {
  // 这是真机踩到的:Supabase access token 默认 1 小时,用户录了 1:00:10,
  // 录完上传时服务端回 `"exp" claim timestamp check failed`。
  const client = fakeClient()
  client.auth.getSession = async () => ({
    data: { session: { access_token: 'stale', expires_at: Math.floor(Date.now() / 1000) + 60 } },
  })
  client.auth.refreshSession = async () => ({ data: { session: { access_token: 'renewed' } } })
  assert.equal(await freshAccessToken(client), 'renewed')
})

test('续期失败时交出旧 token,让服务端说真话而不是自己编一个错', async () => {
  const client = fakeClient()
  client.auth.getSession = async () => ({
    data: { session: { access_token: 'stale', expires_at: Math.floor(Date.now() / 1000) + 10 } },
  })
  client.auth.refreshSession = async () => ({ data: { session: null } })
  assert.equal(await freshAccessToken(client), 'stale')
})

test('轮询退避:开头快、封顶 5s', () => {
  assert.equal(transcriptionPollDelayMs(0), 1000)
  assert.equal(transcriptionPollDelayMs(2), 2000)
  assert.equal(transcriptionPollDelayMs(4), 5000)
  // 越界不炸,停在封顶值 —— 一小时会议会轮几百次。
  assert.equal(transcriptionPollDelayMs(999), 5000)
  assert.equal(transcriptionPollDelayMs(-1), 1000)
})

test('终态判定覆盖失败和取消,不只是成功', () => {
  assert.equal(isTerminalTranscriptionStatus('succeeded'), true)
  assert.equal(isTerminalTranscriptionStatus('failed'), true)
  assert.equal(isTerminalTranscriptionStatus('cancelled'), true)
  assert.equal(isTerminalTranscriptionStatus('processing'), false)
  assert.equal(isTerminalTranscriptionStatus(''), false)
})

test('贴名字表单丢掉空值,留着用默认标签', () => {
  assert.deepEqual(
    speakerNamesFromDraft({ spk_0: ' 张三 ', spk_1: '', spk_2: '   ', spk_3: '李四' }),
    { spk_0: '张三', spk_3: '李四' },
  )
  assert.deepEqual(speakerNamesFromDraft(null), {})
})

test('文档标题取第一段话,超长截断加省略号', () => {
  assert.equal(
    documentTitleFromTranscript({ segments: [{ text: '今天开个短会。' }] }),
    '今天开个短会。',
  )
  const long = documentTitleFromTranscript({
    segments: [{ text: '这是一段很长很长很长很长很长很长的开场白内容' }],
  })
  assert.equal(long, '这是一段很长很长很长很长很长很长的开场白…')
  assert.equal(documentTitleFromTranscript({ segments: [] }, '录音转写'), '录音转写')
  assert.equal(documentTitleFromTranscript(null, '兜底'), '兜底')
})

test('每个状态都有给人看的文案,未知状态也不露底', () => {
  assert.equal(transcriptionStatusLabel('uploading'), '正在上传录音…')
  assert.equal(transcriptionStatusLabel('processing'), '正在识别(长录音需要几分钟)…')
  assert.equal(transcriptionStatusLabel('failed'), '识别失败')
  assert.match(transcriptionStatusLabel('weird_status'), /处理中/)
})

test('建作业时把单声道之外的参数如实带上', async () => {
  const client = fakeClient({ invoke: () => ({ data: { jobId: 'job-1' }, error: null }) })
  const result = await createTranscriptionUpload(client, {
    contentType: 'audio/webm',
    title: '周会',
    speakerCount: 3,
  })

  assert.equal(result.jobId, 'job-1')
  const call = client.calls[0]
  assert.equal(call.name, 'transcribe')
  assert.equal(call.body.action, 'create_transcription_upload')
  assert.equal(call.body.payload.contentType, 'audio/webm')
  assert.equal(call.body.payload.diarizationEnabled, true)
  assert.equal(call.body.payload.speakerCount, 3)
  assert.equal(Object.hasOwn(call.body.payload, 'projectId'), false)
  assert.deepEqual(call.body.payload.languageHints, ['zh', 'en'])
  assert.equal(call.headers.Authorization, 'Bearer token-1')
})

test('Edge Function 用 200 回 { error } 时也要抛出来', async () => {
  const client = fakeClient({ invoke: () => ({ data: { error: 'transcription_upstream_not_configured' }, error: null }) })
  await assert.rejects(
    () => createTranscriptionUpload(client, {}),
    /transcription_upstream_not_configured/,
  )
})

test('非 2xx 时读出响应体里的真实原因,而不是 supabase-js 的通用文案', async () => {
  // supabase-js 只给 "Edge Function returned a non-2xx status code",真原因在
  // error.context 的 body 里。不读出来的话线上所有失败都长一个样。
  const client = fakeClient({
    invoke: () => ({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: { json: async () => ({ error: 'transcription_upstream_not_configured' }) },
      }),
    }),
  })
  await assert.rejects(
    () => createTranscriptionUpload(client, {}),
    /transcription_upstream_not_configured/,
  )
})

test('响应体读不出来时退回原始信息,不吞掉错误', async () => {
  const client = fakeClient({
    invoke: () => ({
      data: null,
      error: Object.assign(new Error('boom'), {
        context: { json: async () => { throw new TypeError('not json') } },
      }),
    }),
  })
  await assert.rejects(() => createTranscriptionUpload(client, {}), /boom/)
})

test('未登录直接拒绝,不去打函数', async () => {
  const client = fakeClient()
  client.auth.getSession = async () => ({ data: { session: null } })
  await assert.rejects(() => createTranscriptionUpload(client, {}), /请先登录/)
  assert.equal(client.calls.length, 0)
})

test('音频用登录令牌认证直传,路径缺失时不上传', async () => {
  // 签名上传 URL 在 opentrust 上只有 60 秒有效期,长录音必死 —— 必须走认证直传。
  const client = fakeClient()
  await uploadTranscriptionAudio(
    client,
    { storagePath: 'user-1/a.webm', bucket: 'voice-transcriptions', contentType: 'audio/webm' },
    { type: 'audio/webm' },
  )
  const call = client.calls[0]
  assert.equal(call.bucket, 'voice-transcriptions')
  assert.equal(call.path, 'user-1/a.webm')
  assert.equal(call.options.contentType, 'audio/webm')
  assert.equal(call.options.upsert, false)

  const bare = fakeClient()
  await assert.rejects(() => uploadTranscriptionAudio(bare, {}, {}), /上传凭据缺失/)
  assert.equal(bare.calls.length, 0)
})

test('上传前把会话续到至少还剩半小时 —— 网关收完整个请求体才校验令牌', async () => {
  const client = fakeClient()
  let refreshed = 0
  // 剩 15 分钟:对普通请求足够(阈值 5 分钟),对大文件上传不够(阈值 30 分钟)。
  client.auth.getSession = async () => ({
    data: { session: { access_token: 'mid', expires_at: Math.floor(Date.now() / 1000) + 900 } },
  })
  client.auth.refreshSession = async () => {
    refreshed += 1
    return { data: { session: { access_token: 'renewed' } } }
  }
  await uploadTranscriptionAudio(client, { storagePath: 'user-1/a.webm' }, { type: 'audio/webm' })
  assert.equal(refreshed, 1)
})

test('上传失败要抛出 storage 的原因', async () => {
  const client = fakeClient({ upload: () => ({ data: null, error: { message: 'Payload too large' } }) })
  await assert.rejects(
    () => uploadTranscriptionAudio(client, { storagePath: 'p' }, {}),
    /Payload too large/,
  )
})

test('贴名字提交前先过滤空值', async () => {
  const client = fakeClient({ invoke: () => ({ data: { jobId: 'job-1' }, error: null }) })
  await updateTranscriptionSpeakers(client, 'job-1', { spk_0: '张三', spk_1: '  ' })
  assert.deepEqual(client.calls[0].body.payload.speakerNames, { spk_0: '张三' })
})

test('原录音走 fetch→blob,不把签名 URL 直接交给 audio 标签', async () => {
  // CSP 的 media-src 不含存储域名(只有 'self' asset: blob:),签名 URL 直接进
  // <audio src> 会被拦死;connect-src 放行了该域名,所以只能 fetch 后转 blob。
  const client = fakeClient({
    invoke: () => ({ data: { audioUrl: 'https://x.opentrust.net/storage/v1/object/sign/a.webm?token=t', contentType: 'audio/webm', durationMs: 179510 }, error: null }),
  })
  const fetched = []
  const result = await loadTranscriptionAudioUrl(client, 'job-1', {
    fetchImpl: async url => { fetched.push(url); return { ok: true, blob: async () => ({ fake: 'blob' }) } },
    createObjectUrl: value => `blob:fake/${value.fake}`,
  })

  assert.equal(client.calls[0].body.action, 'get_transcription_audio')
  assert.equal(fetched.length, 1)
  assert.match(fetched[0], /^https:\/\/x\.opentrust\.net/)
  assert.equal(result.objectUrl, 'blob:fake/blob')
  assert.equal(result.durationMs, 179510)
})

test('音频下载失败要带上状态码,不静默给一个空播放器', async () => {
  const client = fakeClient({ invoke: () => ({ data: { audioUrl: 'https://x/a.webm' }, error: null }) })
  await assert.rejects(
    () => loadTranscriptionAudioUrl(client, 'job-1', {
      fetchImpl: async () => ({ ok: false, status: 403 }),
      createObjectUrl: () => 'blob:x',
    }),
    /403/,
  )
})

test('文档能否回放取决于 metadata 里的来源作业 id', () => {
  assert.equal(transcriptionJobIdOfDocument({ metadata: { transcription_job_id: ' job-9 ' } }), 'job-9')
  assert.equal(transcriptionJobIdOfDocument({ metadata: {} }), '')
  assert.equal(transcriptionJobIdOfDocument(null), '')
})

test('轮询到终态就停,并把每一跳报给 UI', async () => {
  const seen = []
  const statuses = ['processing', 'processing', 'succeeded']
  let index = 0
  const job = await waitForTranscription('job-1', {
    fetchStatus: async () => ({ jobId: 'job-1', status: statuses[index++] }),
    sleep: async () => {},
    onTick: value => seen.push(value.status),
  })

  assert.equal(job.status, 'succeeded')
  assert.deepEqual(seen, ['processing', 'processing', 'succeeded'])
})

test('失败也是终态,不会一直轮下去', async () => {
  let calls = 0
  const job = await waitForTranscription('job-1', {
    fetchStatus: async () => {
      calls += 1
      return { status: 'failed', errorMessage: 'transcription_submit_failed' }
    },
    sleep: async () => {},
  })
  assert.equal(job.status, 'failed')
  assert.equal(calls, 1)
})

test('shouldStop 让面板关闭后立刻停轮,并且不再回调 UI', async () => {
  let calls = 0
  const seen = []
  const job = await waitForTranscription('job-1', {
    fetchStatus: async () => {
      calls += 1
      return { status: 'processing' }
    },
    sleep: async () => {},
    // 第一跳之后就"关面板"
    shouldStop: () => calls >= 1,
    onTick: value => seen.push(value.status),
  })

  // 返回 null = 调用方不要再 setState(避免卸载后更新组件)。
  // 那一跳的请求已经发出去了(calls===1),但 onTick 必须一次都不触发 ——
  // 请求飞在路上时面板关掉是最常见的时序。
  assert.equal(job, null)
  assert.deepEqual(seen, [])
  assert.equal(calls, 1)
})

test('轮询次数用尽时报超时,而不是无限挂着', async () => {
  await assert.rejects(
    () => waitForTranscription('job-1', {
      fetchStatus: async () => ({ status: 'processing' }),
      sleep: async () => {},
      maxAttempts: 3,
    }),
    /转写超时/,
  )
})

test('没给 fetchStatus 直接报错,不静默空转', async () => {
  await assert.rejects(() => waitForTranscription('job-1', {}), /需要 fetchStatus/)
})
