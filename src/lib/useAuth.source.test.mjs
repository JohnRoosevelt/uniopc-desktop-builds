import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../hooks/useAuth.jsx', import.meta.url), 'utf8')

test('useAuth imports the Supabase function caller used by profile updates', () => {
  assert.match(source, /import \{ supabase, callSupabaseFunction \} from '\.\.\/lib\/supabase'/)
  assert.match(source, /await callSupabaseFunction\('update-profile', data\)/)
})

test('useAuth sends existing phone accounts through login before checking new-account registration', () => {
  assert.match(source, /signInWithOtp\(\{\s*phone,\s*options: \{ shouldCreateUser: false \}/)
  assert.match(source, /await assertPhoneRegistrationAllowed\(supabase, phone\)/)
  assert.match(source, /signInWithOtp\(\{\s*phone,\s*options: \{ shouldCreateUser: true \}/)
  assert.doesNotMatch(source, /signInWithEmail|signUpWithEmail|signInWithPassword|auth\.signUp/)
})

test('useAuth refreshes Supabase session after profile metadata updates', () => {
  assert.match(source, /async function refreshUpdatedSessionUser\(expectedUid\)/)
  assert.match(source, /await supabase\.auth\.refreshSession\(\)/)
  assert.match(source, /result\.user \|\| refreshedUser/)
  assert.match(source, /setUser\(nextUser\)/)
})

test('signOut stops the logged-out account local engine and clears the active marker', () => {
  // Regression guard for the cross-account leak: without this, the gateway
  // child keeps serving the previous account's state after logout.
  assert.match(source, /async function signOut\(\)/)
  assert.match(source, /await invoke\('openclaw_logout_active_profile'\)/)
})
