import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('desktop failure report requires explicit consent and sends a sanitized summary', () => {
  const page = read('src/pages/OpenClawRuntime.jsx')
  assert.match(page, /我已查看上述字段，并同意/)
  assert.match(page, /disabled=\{!diagnosticsConsent \|\| diagnosticsSending\}/)
  assert.match(page, /supabase\.functions\.invoke\('desktop-diagnostics'/)
  assert.doesNotMatch(page, /report\.events[\s\S]{0,100}detail:/)
  assert.match(page, /不包含账号、Profile 名称、文件路径、错误原文或完整日志/)
})

test('platform diagnostics view is wired through the platform-admin API action', () => {
  const page = read('src/pages/PlatformDiagnostics.jsx')
  const app = read('src/App.jsx')
  assert.match(page, /admin_list_desktop_diagnostics/)
  assert.match(page, /最多显示最近 200 条/)
  assert.match(app, /path="\/platform\/diagnostics" element=\{<AuthGuard><PlatformDiagnostics \/><\/AuthGuard>\}/)
  assert.match(page, /report\.submission_mode === 'anonymous' \? '匿名' : '登录用户'/)
})

test('the login screen offers an explicit-consent anonymous diagnostic path', () => {
  const login = read('src/pages/Login.jsx')
  assert.match(login, /登录遇到问题？发送匿名诊断摘要/)
  assert.match(login, /同意并匿名发送/)
  assert.match(login, /submissionMode: 'anonymous'/)
  assert.match(login, /loginFailure=\{error \|\| authError\}/)
})
