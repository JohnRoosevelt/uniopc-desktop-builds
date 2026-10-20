import assert from 'node:assert/strict'
import test from 'node:test'

import { createPrivateConversionService } from './privateConversionService.js'

test('private conversion and media operations use the Plugins function contract', async () => {
  const calls = []
  const service = createPrivateConversionService(async (name, body) => {
    calls.push({ name, body })
    return { ok: true }
  })

  await service.callPrivateConversion('operator_list_org_channels', { channelType: 'video' })
  await service.callMedia('operator_list_media_assets', { assetType: 'video' })

  assert.deepEqual(calls, [
    {
      name: 'private-conversion',
      body: { action: 'operator_list_org_channels', payload: { channelType: 'video' } },
    },
    {
      name: 'media',
      body: { action: 'operator_list_media_assets', payload: { assetType: 'video' } },
    },
  ])
})

test('audio and video processing retain their flat action payload contract on Plugins', async () => {
  const calls = []
  const service = createPrivateConversionService(async (name, body) => {
    calls.push({ name, body })
    return { taskId: 'task-1' }
  })

  await service.callVideoToAudio('convert', { sourceKey: 'media/a.mp4' })
  await service.callAudioUnderstanding('query', { taskId: 'task-1' })

  assert.deepEqual(calls, [
    { name: 'video-to-audio', body: { action: 'convert', sourceKey: 'media/a.mp4' } },
    { name: 'audio-understanding', body: { action: 'query', taskId: 'task-1' } },
  ])
})
