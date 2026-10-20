import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createDesktopAuthStorage, desktopAuthStorage } from './authSessionStorage.js'

function fakeStore() {
  const values = new Map()
  return {
    values,
    async get(key) { return values.get(key) },
    async set(key, value) { values.set(key, value) },
    async delete(key) { values.delete(key) },
    async save() {},
  }
}

test('desktop auth session survives a full WebView localStorage', async () => {
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError') },
    removeItem: () => {},
  }
  try {
    const nativeStore = fakeStore()
    const storage = createDesktopAuthStorage({ loadStore: async () => nativeStore })
    await storage.setItem('sb-auth-token', '{"access_token":"test"}')
    assert.equal(await storage.getItem('sb-auth-token'), '{"access_token":"test"}')
    await storage.removeItem('sb-auth-token')
    assert.equal(await storage.getItem('sb-auth-token'), null)
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('existing WebView session migrates only after native save succeeds', async () => {
  const previous = globalThis.localStorage
  const legacy = new Map([['sb-auth-token', '{"refresh_token":"old"}']])
  globalThis.localStorage = {
    getItem: key => legacy.get(key) ?? null,
    removeItem: key => legacy.delete(key),
  }
  try {
    const nativeStore = fakeStore()
    let failSave = true
    nativeStore.save = async () => { if (failSave) throw new Error('disk unavailable') }
    const storage = createDesktopAuthStorage({ loadStore: async () => nativeStore })
    await assert.rejects(storage.getItem('sb-auth-token'), /disk unavailable/)
    assert.equal(legacy.has('sb-auth-token'), true)
    failSave = false
    assert.equal(await storage.getItem('sb-auth-token'), '{"refresh_token":"old"}')
    assert.equal(legacy.has('sb-auth-token'), false)
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('native auth storage is used only in the desktop host', () => {
  const previous = globalThis.window
  try {
    globalThis.window = {}
    assert.equal(desktopAuthStorage(), undefined)
    globalThis.window = { __TAURI_INTERNALS__: {} }
    assert.equal(typeof desktopAuthStorage().getItem, 'function')
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
})

test('Supabase OTP verification persists its session despite WebView quota exhaustion', async () => {
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError') },
    removeItem: () => {},
  }
  try {
    const nativeStore = fakeStore()
    const client = createClient('https://example.supabase.co', 'test-anon-key', {
      auth: {
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage: createDesktopAuthStorage({ loadStore: async () => nativeStore }),
      },
      global: {
        fetch: async () => new Response(JSON.stringify({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          token_type: 'bearer',
          expires_in: 3600,
          user: { id: 'test-user-id', aud: 'authenticated' },
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
      },
    })
    const result = await client.auth.verifyOtp({ phone: '10000000000', token: '000000', type: 'sms' })
    assert.equal(result.error, null)
    assert.equal(result.data.session?.access_token, 'test-access-token')
    assert.equal(JSON.parse(nativeStore.values.get('sb-example-auth-token')).refresh_token, 'test-refresh-token')
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})
