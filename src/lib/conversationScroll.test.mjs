import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONVERSATION_SCROLL_STICKY_THRESHOLD,
  easeOutQuart,
  isConversationScrollPinnedToBottom,
  shouldAutoScrollConversationList,
  smoothScrollConversationToBottom,
} from './conversationScroll.js'

test('detects when the conversation scroller is pinned near the bottom', () => {
  assert.equal(isConversationScrollPinnedToBottom({
    scrollHeight: 1000,
    scrollTop: 620,
    clientHeight: 360,
  }), true)

  assert.equal(isConversationScrollPinnedToBottom({
    scrollHeight: 1000,
    scrollTop: 560,
    clientHeight: 360,
  }), false)
})

test('keeps conversation scroll stable when the user is reading older messages', () => {
  assert.equal(shouldAutoScrollConversationList({
    activeConversationChanged: false,
    wasPinnedToBottom: false,
  }), false)
})

test('auto-scrolls after switching conversations even if the previous list was not pinned', () => {
  assert.equal(shouldAutoScrollConversationList({
    activeConversationChanged: true,
    wasPinnedToBottom: false,
  }), true)
})

test('easeOutQuart starts fast and lands exactly at 1', () => {
  assert.equal(easeOutQuart(0), 0)
  assert.equal(easeOutQuart(1), 1)
  assert.equal(easeOutQuart(0.5) > 0.5, true)
})

function buildFakeScroller({ scrollHeight = 1000, clientHeight = 400, scrollTop = 0 } = {}) {
  const listeners = new Map()
  return {
    scrollHeight,
    clientHeight,
    scrollTop,
    addEventListener(name, handler) { listeners.set(name, handler) },
    removeEventListener(name) { listeners.delete(name) },
    fire(name) { listeners.get(name)?.() },
    listenerCount() { return listeners.size },
  }
}

test('smooth scroll animates to the bottom and cleans up listeners', () => {
  const el = buildFakeScroller()
  const frames = []
  let clock = 0
  smoothScrollConversationToBottom(el, {
    durationMs: 100,
    now: () => 0,
    raf: callback => frames.push(callback),
  })
  while (frames.length > 0) {
    clock += 25
    frames.shift()(clock)
  }
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight)
  assert.equal(el.listenerCount(), 0)
})

test('smooth scroll cancels the moment the user takes over', () => {
  const el = buildFakeScroller()
  const frames = []
  smoothScrollConversationToBottom(el, {
    durationMs: 100,
    now: () => 0,
    raf: callback => frames.push(callback),
  })
  frames.shift()(25)
  const midway = el.scrollTop
  el.fire('wheel')
  while (frames.length > 0) frames.shift()(100)
  assert.equal(el.scrollTop, midway)
  assert.equal(el.listenerCount(), 0)
})

test('uses a small threshold so minor layout shifts still count as pinned', () => {
  assert.equal(CONVERSATION_SCROLL_STICKY_THRESHOLD > 0, true)
  assert.equal(isConversationScrollPinnedToBottom({
    scrollHeight: 1000,
    scrollTop: 1000 - 360 - CONVERSATION_SCROLL_STICKY_THRESHOLD + 1,
    clientHeight: 360,
  }), true)
})
