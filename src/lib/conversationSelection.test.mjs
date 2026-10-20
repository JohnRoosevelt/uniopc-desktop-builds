import test from 'node:test'
import assert from 'node:assert/strict'

import * as conversationSelection from './conversationSelection.js'
import {
  defaultConversationSessionKey,
  resolveActiveConversationTarget,
  sortConversationSessionsByRecency,
} from './conversationSelection.js'

test('does not select retired human collaborators when there are no AI employees', () => {
  const target = resolveActiveConversationTarget({
    employeeIdFromUrl: '',
    humanIdFromUrl: '',
    employees: [],
    humans: [{ id: 'human-1', name: 'Alice' }],
  })

  assert.equal(target, null)
})

test('does not fall back to a retired human collaborator', () => {
  const target = resolveActiveConversationTarget({
    employeeIdFromUrl: 'stale-agent',
    humanIdFromUrl: '',
    employees: [],
    humans: [{ id: 'human-1', name: 'Alice' }],
  })

  assert.equal(target, null)
})

test('keeps valid URL selections before defaulting to the first available employee', () => {
  assert.deepEqual(resolveActiveConversationTarget({
    employeeIdFromUrl: 'agent-2',
    humanIdFromUrl: '',
    employees: [{ id: 'agent-1' }, { id: 'agent-2' }],
    humans: [{ id: 'human-1' }],
  }), { type: 'employee', id: 'agent-2' })

  assert.deepEqual(resolveActiveConversationTarget({
    employeeIdFromUrl: '',
    humanIdFromUrl: 'human-1',
    employees: [{ id: 'agent-1' }],
    humans: [{ id: 'human-1' }],
  }), { type: 'employee', id: 'agent-1' })
})

test('defaults to the first roster target when no URL selection is present', () => {
  assert.deepEqual(resolveActiveConversationTarget({
    employeeIdFromUrl: '',
    humanIdFromUrl: '',
    employees: [{ id: 'agent-1' }],
    humans: [{ id: 'human-1' }],
    roster: [
      { type: 'human', id: 'human-1' },
      { type: 'employee', id: 'agent-1' },
    ],
  }), { type: 'employee', id: 'agent-1' })
})

test('sorts sessions newest first with stable order for missing timestamps', () => {
  const sorted = sortConversationSessionsByRecency([
    { key: 'agent:a:main', updatedAt: 100 },
    { key: 'agent:a:dashboard:1', updatedAt: 300 },
    { key: 'agent:a:dashboard:no-ts-1' },
    { key: 'agent:a:dashboard:2', createdAt: 200 },
    { key: 'agent:a:dashboard:no-ts-2' },
  ])

  assert.deepEqual(sorted.map(item => item.key), [
    'agent:a:dashboard:1',   // updatedAt 300
    'agent:a:dashboard:2',   // createdAt 200 (updatedAt missing → createdAt)
    'agent:a:main',          // updatedAt 100
    'agent:a:dashboard:no-ts-1', // no timestamps keep gateway relative order…
    'agent:a:dashboard:no-ts-2', // …after all timestamped rows
  ])
})

test('sort does not mutate the input array', () => {
  const input = [
    { key: 'agent:a:main', updatedAt: 1 },
    { key: 'agent:a:dashboard:1', updatedAt: 2 },
  ]
  sortConversationSessionsByRecency(input)
  assert.deepEqual(input.map(item => item.key), ['agent:a:main', 'agent:a:dashboard:1'])
})

test('default session key picks the newest session in the recency-sorted list', () => {
  const key = defaultConversationSessionKey({
    employeeId: 'agent-1',
    sessions: [
      { key: 'agent:agent-1:dashboard:fresh', agentId: 'agent-1', updatedAt: 300 },
      { key: 'agent:agent-1:main', agentId: 'agent-1', updatedAt: 100 },
    ],
  })

  assert.equal(key, 'agent:agent-1:dashboard:fresh')
})

test('default session selection ignores cron and worker kinds from the Rust contract', () => {
  const key = defaultConversationSessionKey({
    employeeId: 'agent-1',
    sessions: [
      { key: 'opaque-worker-key', agentId: 'agent-1', kind: 'worker', updatedAt: 400 },
      { key: 'opaque-cron-key', agentId: 'agent-1', kind: 'cron', updatedAt: 300 },
      { key: 'opaque-chat-key', agentId: 'agent-1', kind: 'interactive', updatedAt: 200 },
    ],
  })

  assert.equal(key, 'opaque-chat-key')
})

test('default session selection ignores heartbeat and future background kinds', () => {
  const key = defaultConversationSessionKey({
    employeeId: 'agent-1',
    sessions: [
      { key: 'opaque-heartbeat', agentId: 'agent-1', kind: 'background', updatedAt: 500 },
      { key: 'opaque-future-background', agentId: 'agent-1', kind: 'future-background', updatedAt: 400 },
      { key: 'opaque-chat', agentId: 'agent-1', kind: 'interactive', updatedAt: 300 },
    ],
  })

  assert.equal(key, 'opaque-chat')
})

test('default session key ignores rows still belonging to another employee', () => {
  // The sessions list refreshes async: right after switching employees it can
  // still hold the previous employee's rows — never derive a default from those.
  const key = defaultConversationSessionKey({
    employeeId: 'agent-2',
    sessions: [
      { key: 'agent:agent-1:dashboard:fresh', agentId: 'agent-1', updatedAt: 300 },
      { key: 'agent:agent-1:main', agentId: 'agent-1', updatedAt: 100 },
    ],
  })

  assert.equal(key, 'agent:agent-2:main')
})

test('default session key falls back to the main session for an empty list', () => {
  assert.equal(
    defaultConversationSessionKey({ employeeId: 'agent-1', sessions: [] }),
    'agent:agent-1:main',
  )
  assert.equal(defaultConversationSessionKey({ employeeId: '', sessions: [] }), '')
})

test('does not treat the default assistant session as a Super IP employee session', () => {
  assert.equal(typeof conversationSelection.sessionKeyBelongsToEmployee, 'function')
  const { sessionKeyBelongsToEmployee } = conversationSelection
  assert.equal(
    sessionKeyBelongsToEmployee({
      employeeId: 'superip-producer',
      sessionKey: 'agent:main:main',
    }),
    false,
  )
  assert.equal(
    sessionKeyBelongsToEmployee({
      employeeId: 'superip-producer',
      sessionKey: 'agent:superip-producer:main',
    }),
    true,
  )
})
