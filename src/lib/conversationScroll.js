export const CONVERSATION_SCROLL_STICKY_THRESHOLD = 48

export function isConversationScrollPinnedToBottom(element, threshold = CONVERSATION_SCROLL_STICKY_THRESHOLD) {
  if (!element) return true

  const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
  return distanceToBottom <= threshold
}

export function shouldAutoScrollConversationList({
  activeConversationChanged,
  wasPinnedToBottom,
}) {
  return Boolean(activeConversationChanged || wasPinnedToBottom)
}

export function easeOutQuart(progress) {
  return 1 - Math.pow(1 - progress, 4)
}

// Animated scroll-to-bottom (used by the "回到底部" FAB). The animation hands
// control back to the user the moment they touch the wheel / screen.
export function smoothScrollConversationToBottom(element, {
  durationMs = 500,
  ease = easeOutQuart,
  now = () => performance.now(),
  raf = callback => requestAnimationFrame(callback),
} = {}) {
  if (!element) return
  const from = element.scrollTop
  const startedAt = now()
  let cancelled = false
  const cancel = () => {
    cancelled = true
    element.removeEventListener('wheel', cancel)
    element.removeEventListener('touchstart', cancel)
    element.removeEventListener('pointerdown', cancel)
  }
  element.addEventListener('wheel', cancel, { passive: true })
  element.addEventListener('touchstart', cancel, { passive: true })
  element.addEventListener('pointerdown', cancel, { passive: true })

  const step = timestamp => {
    if (cancelled) return
    const progress = Math.min((timestamp - startedAt) / durationMs, 1)
    // Recompute the target every frame: streaming content keeps growing.
    const target = element.scrollHeight - element.clientHeight
    element.scrollTop = from + (target - from) * ease(progress)
    if (progress < 1) {
      raf(step)
    } else {
      cancel()
      element.scrollTop = element.scrollHeight - element.clientHeight
    }
  }
  raf(step)
}
