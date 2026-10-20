import { Store } from '@tauri-apps/plugin-store'

const AUTH_STORE_FILE = 'auth-session.json'

function legacyLocalStorage() {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

function removeLegacyItem(key) {
  try {
    legacyLocalStorage()?.removeItem(key)
  } catch {
    // Native persistence succeeded; old WebView cleanup can wait.
  }
}

// Supabase accepts an async Storage implementation. Keep the desktop session
// outside WebView localStorage, whose quota is shared with conversation caches.
// Older sessions are moved only after the native store has saved them.
export function createDesktopAuthStorage({ loadStore = () => Store.load(AUTH_STORE_FILE, { autoSave: false }) } = {}) {
  let storePromise
  const store = () => {
    storePromise ||= loadStore()
    return storePromise
  }

  return {
    async getItem(key) {
      const nativeStore = await store()
      const saved = await nativeStore.get(key)
      if (saved != null) return saved

      let previous = null
      try {
        previous = legacyLocalStorage()?.getItem(key) ?? null
      } catch {
        // The native store is still usable when WebView storage is blocked.
      }
      if (previous == null) return null
      await nativeStore.set(key, previous)
      try {
        await nativeStore.save()
      } catch (error) {
        await nativeStore.delete(key)
        throw error
      }
      removeLegacyItem(key)
      return previous
    },

    async setItem(key, value) {
      const nativeStore = await store()
      await nativeStore.set(key, value)
      await nativeStore.save()
      removeLegacyItem(key)
    },

    async removeItem(key) {
      const nativeStore = await store()
      await nativeStore.delete(key)
      await nativeStore.save()
      removeLegacyItem(key)
    },
  }
}

export function desktopAuthStorage() {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__
    ? createDesktopAuthStorage()
    : undefined
}
