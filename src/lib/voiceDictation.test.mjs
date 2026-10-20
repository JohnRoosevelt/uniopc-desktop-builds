import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DICTATION_JOB_TITLE,
  dictationTextFromJob,
  transcribeDictationBlob,
} from './voiceDictation.js'

function makeDeps(overrides = {}) {
  const calls = { deleted: [], started: [], uploads: [] }
  const deps = {
    createTranscriptionUpload: async (client, input) => {
      calls.uploadInput = input
      return { jobId: 'job-1', storagePath: 'u/1.webm', contentType: input.contentType }
    },
    uploadTranscriptionAudio: async (client, upload, blob) => {
      calls.uploads.push({ upload, blob })
    },
    startTranscription: async (client, jobId) => {
      calls.started.push(jobId)
    },
    fetchTranscriptionStatus: async () => ({ status: 'succeeded' }),
    waitForTranscription: async () => ({
      status: 'succeeded',
      segments: [{ text: ' 你好 ' }, { text: '' }, { text: '世界' }],
    }),
    deleteTranscription: async (client, jobId) => {
      calls.deleted.push(jobId)
    },
    ...overrides,
  }
  return { deps, calls }
}

const recorded = { blob: { size: 10, type: 'audio/webm' }, contentType: 'audio/webm' }

test('dictationTextFromJob joins trimmed segment texts and drops empties', () => {
  assert.equal(
    dictationTextFromJob({ segments: [{ text: ' 你好 ' }, { text: '' }, { text: '世界' }] }),
    '你好 世界',
  )
  assert.equal(dictationTextFromJob({}), '')
  assert.equal(dictationTextFromJob({ segments: 'nope' }), '')
})

test('dictation runs upload -> start -> wait, disables diarization, and deletes the job', async () => {
  const { deps, calls } = makeDeps()
  const text = await transcribeDictationBlob({}, recorded, { deps })
  assert.equal(text, '你好 世界')
  assert.equal(calls.uploadInput.diarizationEnabled, false)
  assert.equal(calls.uploadInput.title, DICTATION_JOB_TITLE)
  assert.equal(calls.uploadInput.contentType, 'audio/webm')
  assert.equal(calls.uploads.length, 1)
  assert.deepEqual(calls.started, ['job-1'])
  // 听写不留档:成功后作业被删。
  assert.deepEqual(calls.deleted, ['job-1'])
})

test('dictation surfaces the job error and still deletes the failed job', async () => {
  const { deps, calls } = makeDeps({
    waitForTranscription: async () => ({ status: 'failed', errorMessage: '上游超时' }),
  })
  await assert.rejects(() => transcribeDictationBlob({}, recorded, { deps }), /上游超时/)
  assert.deepEqual(calls.deleted, ['job-1'])
})

test('dictation returns null when aborted and cleans up without throwing', async () => {
  const { deps, calls } = makeDeps({
    waitForTranscription: async () => null,
  })
  const result = await transcribeDictationBlob({}, recorded, { deps })
  assert.equal(result, null)
  assert.deepEqual(calls.deleted, ['job-1'])
})

test('dictation rejects empty recordings and silent transcripts', async () => {
  await assert.rejects(
    () => transcribeDictationBlob({}, { blob: { size: 0 } }, { deps: makeDeps().deps }),
    /没有录到声音/,
  )
  const { deps } = makeDeps({
    waitForTranscription: async () => ({ status: 'succeeded', segments: [] }),
  })
  await assert.rejects(() => transcribeDictationBlob({}, recorded, { deps }), /没有识别到语音内容/)
})
