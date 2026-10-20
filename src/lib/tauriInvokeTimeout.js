import { invoke } from '@tauri-apps/api/core'

export const OPENCLAW_PROFILE_PROVISION_TIMEOUT_MS = 90000

export function invokeWithTimeout(command, payload, timeoutMs = OPENCLAW_PROFILE_PROVISION_TIMEOUT_MS) {
  let timeoutId = null
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
  })

  return Promise.race([invoke(command, payload), timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId)
  })
}
