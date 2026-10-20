// 非 macOS 的对话听写管线:webview 录音 -> 云端 transcribe -> 纯文本回填输入框。
//
// macOS 用 native_voice_input(Speech 框架,本地实时);Windows/Linux 没有系统级
// 语音识别 API,听写复用「录音成文」的同一条 transcribe Edge Function 链路,
// 但按聊天听写的口径收敛:
//   - 关说话人分离(单人对着输入框说话,分离只会拖慢作业);
//   - 不挂 projectId(这不是项目资产);
//   - 转完即删作业 —— 听写文本已经回到输入框,不该在「录音转写」列表里留痕。
//
// 依赖注入同 voiceTranscription.js:client 由调用方传,deps 可换,node --test
// 不碰 import.meta.env 也不需要真网络。

import {
  createTranscriptionUpload,
  uploadTranscriptionAudio,
  startTranscription,
  fetchTranscriptionStatus,
  waitForTranscription,
  deleteTranscription,
} from './voiceTranscription.js'

/** 听写作业在后台列表里的占位标题(删除前短暂存在)。 */
export const DICTATION_JOB_TITLE = '语音输入'

/** 把转写 segments 拼回一段可直接回填输入框的纯文本。 */
export function dictationTextFromJob(job = {}) {
  const segments = Array.isArray(job?.segments) ? job.segments : []
  return segments
    .map(segment => String(segment?.text || '').trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * 一段录音 -> 一段文本。终态后无论成败都尽力删掉作业(失败不阻塞返回)。
 *
 * options.shouldStop 让调用方中断(组件卸载、用户切走):中断返回 null,
 * 调用方据此不再 setState。
 */
export async function transcribeDictationBlob(client, recorded, options = {}) {
  const blob = recorded?.blob
  if (!blob?.size) throw new Error('没有录到声音，请检查麦克风后重试')
  const deps = {
    createTranscriptionUpload,
    uploadTranscriptionAudio,
    startTranscription,
    fetchTranscriptionStatus,
    waitForTranscription,
    deleteTranscription,
    ...options.deps,
  }

  const upload = await deps.createTranscriptionUpload(client, {
    contentType: recorded.contentType || blob.type || 'audio/mp4',
    title: DICTATION_JOB_TITLE,
    diarizationEnabled: false,
  })
  await deps.uploadTranscriptionAudio(client, upload, blob)
  await deps.startTranscription(client, upload.jobId)

  const job = await deps.waitForTranscription(upload.jobId, {
    fetchStatus: jobId => deps.fetchTranscriptionStatus(client, jobId),
    shouldStop: options.shouldStop,
    sleep: options.sleep,
  })
  if (!job) {
    // 调用方已放弃 —— 作业留给服务端跑完,但别让它出现在用户的转写列表里。
    deps.deleteTranscription(client, upload.jobId).catch(() => {})
    return null
  }

  deps.deleteTranscription(client, upload.jobId).catch(() => {})
  if (job.status !== 'succeeded') {
    throw new Error(String(job.errorMessage || '语音识别失败，请重试'))
  }
  const text = dictationTextFromJob(job)
  if (!text) throw new Error('没有识别到语音内容')
  return text
}
