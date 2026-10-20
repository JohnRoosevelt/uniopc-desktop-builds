import test from 'node:test'
import assert from 'node:assert/strict'

import {
  availableModelChoicesFromSnapshot,
  connectedModelSources,
  formatOpenClawModelLabel,
  getModelSetupOption,
  openClawModelOptionsFromSnapshot,
  modelSetupOptionsForSelect,
  providerReadyFromAuthProfiles,
  providerAuthStatusLabel,
  readyAuthProfileLabelsForProvider,
} from './openclawModels.js'

test('openClawModelOptionsFromSnapshot uses ready gateway models only', () => {
  const options = openClawModelOptionsFromSnapshot({
    models: [
      { modelRef: 'qwen/qwen3.5-plus', providerReady: true },
      { modelRef: 'openai/gpt-5.5', providerReady: true },
      { modelRef: 'zai/glm-5', providerReady: false },
    ],
  }, 'minimax-portal/MiniMax-M2.7')

  assert.deepEqual(options, [
    'qwen/qwen3.5-plus',
    'openai/gpt-5.5',
  ])
})

test('openClawModelOptionsFromSnapshot skips unregistered provider models', () => {
  const options = openClawModelOptionsFromSnapshot({
    models: [
      { modelRef: 'bailian-token-plan/qwen3.7-plus', providerReady: true, catalogAvailable: true },
      { modelRef: 'modelstudio/glm-5', providerReady: true, catalogAvailable: false },
    ],
  }, 'bailian-token-plan/qwen3.7-plus')

  assert.deepEqual(options, ['bailian-token-plan/qwen3.7-plus'])
})

test('openClawModelOptionsFromSnapshot does not fabricate models before gateway snapshot loads', () => {
  assert.deepEqual(openClawModelOptionsFromSnapshot(null, 'openai-codex/gpt-5.5'), [])
})

test('openClawModelOptionsFromSnapshot keeps the current qwen profile default when readiness is under-reported', () => {
  const options = openClawModelOptionsFromSnapshot({
    resolvedDefaultModel: 'qwen/qwen3.7-plus',
    models: [
      { modelRef: 'qwen/qwen3.7-plus', providerReady: false },
      { modelRef: 'openai-codex/gpt-5.5', providerReady: false },
    ],
  }, 'qwen/qwen3.7-plus')

  assert.deepEqual(options, ['qwen/qwen3.7-plus'])
})

test('openClawModelOptionsFromSnapshot keeps the current token-plan profile default when readiness is under-reported', () => {
  const options = openClawModelOptionsFromSnapshot({
    resolvedDefaultModel: 'bailian-token-plan/qwen3.7-plus',
    models: [
      { modelRef: 'bailian-token-plan/qwen3.7-plus', providerReady: false },
      { modelRef: 'openai-codex/gpt-5.5', providerReady: false },
    ],
  }, 'bailian-token-plan/qwen3.7-plus')

  assert.deepEqual(options, ['bailian-token-plan/qwen3.7-plus'])
})

test('openClawModelOptionsFromSnapshot keeps the current Codex default when auth profile is ready', () => {
  const options = openClawModelOptionsFromSnapshot({
    resolvedDefaultModel: 'openai-codex/gpt-5.5',
    runtimeCompatReady: true,
    authProfileLabels: ['openai-codex:codex-cli'],
    models: [
      { modelRef: 'openai-codex/gpt-5.5', providerReady: false },
      { modelRef: 'qwen/qwen3.7-plus', providerReady: false },
    ],
  }, 'openai-codex/gpt-5.5')

  assert.deepEqual(options, ['openai-codex/gpt-5.5'])
})

test('availableModelChoicesFromSnapshot lists models instead of provider sources', () => {
  const choices = availableModelChoicesFromSnapshot({
    resolvedDefaultModel: 'bailian-token-plan/qwen3.7-plus',
    providers: [
      { id: 'openai-codex', label: 'OpenAI Codex', ready: false, status: 'cooldown' },
      { id: 'bailian-token-plan', label: '阿里云百炼 Token Plan', ready: true },
    ],
    models: [
      { modelRef: 'bailian-token-plan/qwen3.7-plus', providerReady: true, catalogAvailable: true, contextWindow: 128000 },
      { modelRef: 'bailian-token-plan/qwen-max', providerReady: true, catalogAvailable: true },
      { modelRef: 'openai-codex/gpt-5.5', providerReady: false, providerStatus: 'cooldown' },
    ],
  })

  assert.deepEqual(choices.map(choice => ({
    id: choice.id,
    providerLabel: choice.providerLabel,
    modelLabel: choice.modelLabel,
    current: choice.current,
    status: choice.status,
  })), [
    {
      id: 'bailian-token-plan/qwen3.7-plus',
      providerLabel: '阿里云百炼 Token Plan',
      modelLabel: 'qwen3.7-plus',
      current: true,
      status: '当前默认',
    },
    {
      id: 'bailian-token-plan/qwen-max',
      providerLabel: '阿里云百炼 Token Plan',
      modelLabel: 'qwen-max',
      current: false,
      status: '可切换',
    },
  ])
})

test('formatOpenClawModelLabel names subscription and coding-plan providers', () => {
  assert.equal(formatOpenClawModelLabel('openai/gpt-5.5'), 'OpenAI Codex 订阅 · gpt-5.5')
  assert.equal(formatOpenClawModelLabel('minimax-portal/MiniMax-M2.7'), 'MiniMax 订阅 · MiniMax-M2.7')
  assert.equal(formatOpenClawModelLabel('bailian-token-plan/qwen3.7-plus'), '阿里云百炼 Token Plan · qwen3.7-plus')
  assert.equal(formatOpenClawModelLabel('qwen/qwen3.7-plus'), 'Qwen Coding Plan · qwen3.7-plus')
  assert.equal(formatOpenClawModelLabel('zai/glm-5'), 'Z.AI / GLM Coding Plan · glm-5')
})

test('model setup options describe the fields needed after selection', () => {
  const tokenPlan = getModelSetupOption('bailian-token-plan-cn')
  assert.equal(tokenPlan.provider, 'bailian-token-plan')
  assert.equal(tokenPlan.authType, 'api_key')
  assert.equal(tokenPlan.defaultModel, 'bailian-token-plan/qwen3.7-plus')
  assert.deepEqual(tokenPlan.fields, ['apiKey'])

  const qwen = getModelSetupOption('qwen-coding-cn')
  assert.equal(qwen.provider, 'qwen-coding-cn')
  assert.equal(qwen.authType, 'api_key')
  assert.equal(qwen.defaultModel, 'qwen/qwen3.7-plus')
  assert.deepEqual(qwen.fields, ['apiKey'])

  const qwenStandard = getModelSetupOption('qwen-standard-cn')
  assert.equal(qwenStandard.provider, 'qwen-standard-cn')
  assert.equal(qwenStandard.authType, 'api_key')
  assert.equal(qwenStandard.defaultModel, 'qwen/qwen3.7-plus')

  const minimax = getModelSetupOption('minimax-oauth-cn')
  assert.equal(minimax.authType, 'oauth')
  assert.equal(minimax.defaultModel, 'minimax-portal/MiniMax-M2.7')
  assert.deepEqual(minimax.fields, [])

  const codex = getModelSetupOption('openai-codex')
  assert.equal(codex.authType, 'oauth')
  assert.equal(codex.defaultModel, 'openai/gpt-5.5')
  assert.deepEqual(codex.fields, [])

  const deepseek = getModelSetupOption('deepseek-api')
  assert.equal(deepseek.provider, 'deepseek')
  assert.equal(deepseek.authType, 'api_key')
  assert.equal(deepseek.defaultModel, 'deepseek/deepseek-v4-flash')
  assert.deepEqual(deepseek.fields, ['apiKey'])
  assert.equal(deepseek.disabled, undefined)
})

test('modelSetupOptionsForSelect keeps primary choices focused', () => {
  assert.deepEqual(
    modelSetupOptionsForSelect().map(option => option.id).slice(0, 5),
    ['uniopc-official', 'openai-codex', 'minimax-oauth-cn', 'bailian-token-plan-cn', 'qwen-coding-cn'],
  )
})

test('connectedModelSources shows ready providers and marks the current default', () => {
  const sources = connectedModelSources({
    providers: [
      { id: 'openai-codex', label: 'OpenAI Codex', ready: true, recommendedModel: 'openai-codex/gpt-5.5' },
      { id: 'qwen', label: 'Qwen Coding Plan', ready: true, recommendedModel: 'qwen/qwen3.7-plus' },
      { id: 'zai', label: 'Z.AI', ready: false, recommendedModel: 'zai/glm-5' },
    ],
  }, {
    resolvedDefaultModel: 'openai-codex/gpt-5.5',
  })

  assert.deepEqual(sources, [
    {
      id: 'openai-codex',
      label: 'OpenAI Codex',
      modelRef: 'openai-codex/gpt-5.5',
      current: true,
      status: '已连接',
    },
    {
      id: 'qwen',
      label: 'Qwen Coding Plan',
      modelRef: 'qwen/qwen3.7-plus',
      current: false,
      status: '已连接',
    },
  ])
})

test('connectedModelSources falls back to current model status without snapshot', () => {
  assert.deepEqual(connectedModelSources(null, {
    providerReady: true,
    resolvedDefaultModel: 'openai/gpt-5.4',
  }), [
    {
      id: 'openai',
      label: 'OpenAI API Key',
      modelRef: 'openai/gpt-5.4',
      current: true,
      status: '已连接',
    },
  ])
})

test('connectedModelSources does not show Codex as connected when current profile lacks OAuth', () => {
  assert.deepEqual(connectedModelSources({
    providers: [
      {
        id: 'openai-codex',
        label: 'OpenAI Codex',
        ready: false,
        recommendedModel: 'openai-codex/gpt-5.5',
      },
    ],
  }, {
    providerReady: false,
    resolvedDefaultModel: 'openai-codex/gpt-5.5',
    missingProvidersInUse: ['openai-codex'],
  }), [])
})

test('connectedModelSources hides Codex when runtime compatibility is broken', () => {
  assert.deepEqual(connectedModelSources({
    runtimeCompatReady: false,
    providers: [
      {
        id: 'openai-codex',
        label: 'OpenAI Codex',
        ready: true,
        recommendedModel: 'openai-codex/gpt-5.5',
      },
    ],
  }, {
    providerReady: false,
    resolvedDefaultModel: 'openai-codex/gpt-5.5',
  }), [])
})

test('providerReadyFromAuthProfiles recognizes current agent OAuth labels', () => {
  assert.equal(providerReadyFromAuthProfiles({
    authProfileLabels: ['openai-codex:bootiful.wtf@gmail.com'],
  }, 'openai-codex'), true)
  assert.equal(providerReadyFromAuthProfiles({
    authProfileLabels: ['openai:bootiful.wtf@gmail.com'],
  }, 'openai-codex'), true)
  assert.deepEqual(readyAuthProfileLabelsForProvider({
    authProfileLabels: [
      'openai-codex:bootiful.wtf@gmail.com',
      'openai:codex@example.com',
      'openai-codex:old@example.com [expired]',
      'minimax-portal:user@example.com',
    ],
  }, 'openai-codex'), ['openai-codex:bootiful.wtf@gmail.com', 'openai:codex@example.com'])
})

test('providerAuthStatusLabel describes cooldown without rate-limit wording', () => {
  assert.equal(providerAuthStatusLabel({ status: 'cooldown' }), '鉴权冷却中')
  assert.equal(providerAuthStatusLabel({ status: 'disabled' }), '账号暂不可用')
})
