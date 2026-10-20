import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const source = fs.readFileSync(path.join(repoRoot, 'src/lib/montageFuncs.js'), 'utf8')

test('smart montage funcs client has no plugin or montage Edge Function dependency', () => {
  assert.match(source, /VITE_COPYWRITING_API_URL/)
  assert.match(source, /VITE_VIDEO_CLIPS_API_URL/)
  assert.match(source, /VITE_COPYWRITING_BEARER_TOKEN/)
  assert.match(source, /VITE_VIDEO_CLIPS_BEARER_TOKEN/)
  assert.match(source, /u_token: `Bearer \$\{token\}`/)
  assert.match(source, /Authorization: `Bearer \$\{config\.copywritingBearerToken\}`/)
  assert.match(source, /Authorization: `Bearer \$\{config\.videoClipsBearerToken\}`/)
  assert.match(source, /\/api\/v1\/copywriting\/generate/)
  assert.match(source, /\/api\/v1\/skills/)
  assert.match(source, /\/montage\/plan/)
  assert.match(source, /\/minimax\/voices/)
  assert.match(source, /Idempotency-Key/)
  assert.match(source, /\/jobs\/\$\{encodeURIComponent\(text\(jobId\)\)\}\/refresh/)
  assert.doesNotMatch(source, /callMontage/)
  assert.doesNotMatch(source, /pluginsBackend/)
  assert.doesNotMatch(source, /functions\/v1\/montage/)
})

test('smart montage funcs client refreshes the signed-in session once on 401', () => {
  assert.match(source, /if \(response\.status === 401\) response = await send\(await userToken\(\{ refresh: true \}\)\)/)
  assert.match(source, /freshAccessToken\(supabase, 60\)/)
  assert.match(source, /supabase\.auth\.refreshSession/)
})
