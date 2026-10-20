import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveProfileChatReadiness } from './profileChatReadiness.js'

const baseInput = {
  activeProfile: 'sales-owner-demo',
  gatewayReady: true,
  officialModelState: 'connected',
  officialModelProfile: 'sales-owner-demo',
  modelLabel: 'MiniMax-M3',
}

test('profile chat readiness narrates the startup chain before enabling send', () => {
  assert.deepEqual(
    deriveProfileChatReadiness({ ...baseInput, activeProfile: '' }),
    {
      phase: 'profile_pending',
      loading: true,
      sendReady: false,
      failed: false,
      label: 'MiniMax-M3',
      detail: '正在确认 Uniopc 引擎 Profile',
      error: null,
    },
  )

  assert.equal(
    deriveProfileChatReadiness({ ...baseInput, gatewayReady: false }).phase,
    'gateway_starting',
  )
  // Catalog refresh is display metadata, not a second readiness gate: it must
  // not make the composer disagree with the app-level startup strip.
  assert.equal(
    deriveProfileChatReadiness({
      ...baseInput,
      officialModelState: 'idle',
      officialModelProfile: '',
      modelSnapshotLoading: true,
    }).phase,
    'official_model_connecting',
  )
  assert.equal(
    deriveProfileChatReadiness({
      ...baseInput,
      officialModelState: 'connecting',
    }).phase,
    'official_model_connecting',
  )
  assert.equal(deriveProfileChatReadiness(baseInput).sendReady, true)
})

test('profile chat readiness holds send on model failure but keeps the selected model label', () => {
  const readiness = deriveProfileChatReadiness({
    ...baseInput,
    officialModelState: 'failed',
    officialModelError: 'credential rejected',
  })

  assert.deepEqual(readiness, {
    phase: 'failed',
    loading: false,
    sendReady: false,
    failed: true,
    label: 'MiniMax-M3',
    detail: 'Uniopc 官方模型连接失败',
    error: 'credential rejected',
  })
})
