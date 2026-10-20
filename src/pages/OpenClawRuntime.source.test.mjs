import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('openclaw runtime is managed from the profile workspace system menu', () => {
  const app = read('src/App.jsx')
  const layout = read('src/components/Layout.jsx')
  const page = read('src/pages/OpenClawRuntime.jsx')

  assert.equal(app.includes("const OpenClawRuntime = lazyPage(() => import('./pages/OpenClawRuntime'))"), true)
  assert.equal(app.includes('path="/profiles/:profileRef/environment" element={profileWorkspaceElement(<OpenClawRuntime />)}'), true)
  assert.equal(app.includes('path="/profiles/:profileRef/openclaw-runtime" element={profileWorkspaceElement(<OpenClawRuntime />)}'), true)
  assert.equal(app.includes('includeOpenClawGuard: false'), true)
  assert.equal(app.includes('<ProfileWorkspaceRedirect childPath="openclaw-runtime" />'), true)

  // 运行环境 moved from the sidebar into the Settings 系统管理 section; the route
  // itself is unchanged (asserted against App above).
  assert.equal(layout.includes("to: profileRoutePath('environment')"), false)
  assert.equal(layout.includes("to: profileRoutePath('openclaw-runtime')"), false)
  assert.equal(layout.includes('我的 Uniopc 引擎'), false)
  assert.equal(layout.includes("label: 'Uniopc 引擎 版本'"), false)
  assert.equal(layout.includes("pathname.startsWith('/profiles/') && pathname.includes('/openclaw-runtime')"), true)

  assert.equal(page.includes("invoke('openclaw_status')"), false)
  assert.equal(page.includes("invoke('openclaw_check_update')"), true)
  assert.equal(page.includes("invoke(status.installed ? 'openclaw_update' : 'openclaw_install')"), true)
  assert.equal(page.includes('所有本机 Uniopc 引擎 profile 共用这套运行时'), true)
  assert.equal(page.includes('profile 页面只管理自己的 Gateway、模型登录和 AI 员工'), true)

  // Engine log surfaced on the diagnostics page (stdout/stderr captured to file
  // instead of /dev/null) with a copy-diagnostics affordance.
  assert.equal(page.includes("invoke('openclaw_gateway_log_tail'"), true)
  assert.equal(page.includes('复制诊断信息'), true)
})

test('runtime diagnostics show recent Uniopc engine startup timings', () => {
  const page = read('src/pages/OpenClawRuntime.jsx')
  const runtime = read('src-tauri/src/commands/model/runtime.rs')
  const app = read('src-tauri/src/lib.rs')

  assert.equal(page.includes("invoke('openclaw_startup_metrics'"), true)
  assert.equal(page.includes('最近启动记录'), true)
  assert.equal(page.includes('总耗时'), true)
  assert.equal(page.includes('运行环境准备'), true)
  assert.equal(page.includes('引擎就绪'), true)
  assert.equal(page.includes('sanitizeBrand(metric.failure)'), true)
  assert.equal(page.includes('sanitizeBrand(status.binaryPath)'), true)
  assert.equal(runtime.includes('pub async fn openclaw_startup_metrics'), true)
  assert.equal(app.includes('commands::model::runtime::openclaw_startup_metrics'), true)
})

test('legacy organization routes redirect into profile workspace system routes', () => {
  const app = read('src/App.jsx')
  const orgShellStart = app.indexOf('<Route element={workspaceShell(<Layout appMode={appMode} />, { includeOpenClawGuard: false })}>')
  const guardedShellStart = app.indexOf('<Route element={workspaceShell(<Layout appMode={appMode} />)}>')
  const adminRoute = app.indexOf('path="/admin" element={<Navigate to="/conversations" replace />}')
  const adminMemberRoute = app.indexOf('path="/admin/member/:memberId" element={<Navigate to="/conversations" replace />}')
  const runtimeRoute = app.indexOf('path="/openclaw-runtime" element={<ProfileWorkspaceRedirect childPath="openclaw-runtime" />}')

  assert.ok(orgShellStart > 0)
  assert.ok(guardedShellStart > orgShellStart)
  assert.ok(adminRoute > orgShellStart && adminRoute < guardedShellStart)
  assert.ok(adminMemberRoute > orgShellStart && adminMemberRoute < guardedShellStart)
  assert.ok(runtimeRoute > orgShellStart && runtimeRoute < guardedShellStart)
})

test('profile workspace guard refreshes in background while startup failures remain globally accessible', () => {
  const app = read('src/App.jsx')

  assert.equal(app.includes('const cachedGuardReady = requiresLocalOpenClaw'), true)
  assert.equal(app.includes('setChecked(cachedGuardReady)'), true)
  // Engine readiness never blocks entry; the global strip only renders failures.
  assert.equal(app.includes('((runtime.openClaw.loading || !checked) && !openClawReady)'), false)
  assert.equal(
    app.includes('<EngineStatusStrip />'),
    true,
  )
  assert.equal(app.includes('{requiresLocalOpenClaw && checked && !openClawReady ? <EngineStatusStrip /> : null}'), false)
  assert.equal(app.includes('requiresRemoteGatewayConnection'), false)
  assert.equal(app.includes('remoteGatewayReady'), false)
})

test('profile pages link to global runtime management instead of updating the cli inline', () => {
  const models = read('src/pages/ModelSettings.jsx')
  const operations = read('src/pages/Operations.jsx')

  assert.equal(models.includes('Uniopc 引擎 与 Codex 插件版本不兼容'), true)
  assert.equal(models.includes("to={profileRoutePath('openclaw-runtime')}"), true)
  assert.equal(models.includes('Uniopc 引擎 CLI 和兼容版本是这台 Mac 的全局运行时'), true)
  assert.equal(models.includes('Uniopc 引擎 版本管理'), true)

  assert.equal(operations.includes('Uniopc 引擎 版本管理'), true)
  assert.equal(operations.includes("to={profileRoutePath('openclaw-runtime')}"), true)
  assert.equal(operations.includes("onClick={checkOpenClawUpdate}"), false)
  assert.equal(operations.includes("onClick={updateOpenClaw}"), false)
})

test('non-interactive OpenClaw commands use the native hidden Windows process route', () => {
  const cli = read('src-tauri/src/services/openclaw_cli.rs')
  const model = read('src-tauri/src/commands/model/mod.rs')
  const commandStart = model.indexOf('async fn command_output_impl_with_env')
  const commandEnd = model.indexOf('async fn command_output(', commandStart)
  const commandBody = model.slice(commandStart, commandEnd)

  assert.ok(commandStart >= 0 && commandEnd > commandStart)
  assert.equal(cli.includes('pub async fn openclaw_cli_output'), true)
  assert.equal(commandBody.includes('openclaw_cli::openclaw_cli_output'), true)
})

test('Windows gateway launches the bundled Node entry directly before considering a cmd shim', () => {
  const cli = read('src-tauri/src/services/openclaw_cli.rs')
  const directNode = cli.indexOf('if entry.is_file() && node.is_file()')
  const cmdFallback = cli.indexOf('let cmd_shim = dir.join("uniopc-engine.cmd")')
  assert.match(cli, /\.join\("node_modules"\)\s*\.join\("uniopc-engine"\)\s*\.join\("uniopc-engine\.mjs"\)/)

  assert.ok(directNode >= 0 && cmdFallback > directNode)
})

test('Windows runtime Node version probes also hide their console window', () => {
  const runtime = read('src-tauri/src/services/openclaw_bundled_runtime.rs')
  const start = runtime.indexOf('fn installed_node_version')
  const end = runtime.indexOf('/// A runtime directory is usable', start)
  const body = runtime.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.equal(body.includes('hide_console(&mut command)'), true)
})

test('desktop titlebar visibly distinguishes installed and development builds', () => {
  const layout = read('src/components/Layout.jsx')

  assert.equal(layout.includes("const BUILD_FLAVOR = import.meta.env.DEV ? '开发测试版' : '正式版'"), true)
  assert.equal(layout.includes('{BUILD_FLAVOR}'), true)
})

test('conversation messages and copied text use the user-facing brand sanitizer', () => {
  const conversations = read('src/pages/Conversations.jsx')

  assert.equal(conversations.includes('<ConversationInlineTokens content={sanitizeBrand(content)} role={role}'), true)
  assert.equal(conversations.includes('<ConversationMarkdownBody content={sanitizeBrand(content)} streaming={streaming} />'), true)
  assert.equal(conversations.includes('const text = sanitizeBrand(String(message?.content || \'\'))'), true)
})

test('fresh local profiles do not wait for a Gateway that the app starts after onboarding', () => {
  const model = read('src-tauri/src/commands/model/mod.rs')
  const provisionStart = model.indexOf('async fn openclaw_profile_provision_impl')
  const provisionEnd = model.indexOf('async fn openclaw_profile_status_impl')
  const provisionBody = model.slice(provisionStart, provisionEnd)

  assert.ok(provisionStart >= 0 && provisionEnd > provisionStart)
  assert.equal(provisionBody.includes('"--skip-health"'), true)
})

test('fresh profile provisioning clears the retired ACPX bridge before starting the Gateway', () => {
  const model = read('src-tauri/src/commands/model/mod.rs')
  const provisionStart = model.indexOf('async fn openclaw_profile_provision_impl')
  const provisionEnd = model.indexOf('async fn openclaw_profile_status_impl')
  const provisionBody = model.slice(provisionStart, provisionEnd)
  const onboard = provisionBody.indexOf('openclaw_output_for_profile(&app, &profile, &onboard_args)')
  const cleanup = provisionBody.indexOf('cleanup_legacy_acpx_bridge_for_profile(&profile)')
  const spawn = provisionBody.indexOf('.ensure_running()')

  assert.ok(onboard >= 0 && cleanup > onboard && spawn > cleanup)
})
