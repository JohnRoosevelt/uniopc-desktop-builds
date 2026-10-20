import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

test('cloud workspace app center id is treated as a cloud agent plugin', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const source = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspacePluginAuth.js'), 'utf8')

  assert.match(source, /CLOUD_AGENT_PLUGIN_IDS[\s\S]*'uniopc-cloud-workspace'/)
  assert.match(source, /CLOUD_AGENT_PLUGIN_IDS[\s\S]*'uniopc-socials'/)
  assert.match(source, /CLOUD_AGENT_PLUGIN_IDS[\s\S]*'uniopc-private-conversion'/)
})

test('cloud workspace requests host credentials with the single plugin id', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const source = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspacePluginAuth.js'), 'utf8')

  assert.match(source, /const runtimePluginId = cloudAgentRuntimePluginId/)
  assert.match(source, /const issuerPluginId = cloudAgentIssuerPluginId\(runtimePluginId\)/)
  assert.match(source, /pluginId: issuerPluginId/)
  assert.doesNotMatch(source, /\['uniopc-cloud-workspace',\s*'uniopc-cloud-workspace'\]/)
  assert.match(source, /persistHostCredential\(normalizedProfile, runtimePluginId, payload\.hostCredential\)/)
  assert.match(source, /pluginId: 'uniopc-cloud-workspace'/)
})

test('official cloud agent plugins map to their matching Supabase function URLs', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const source = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspacePluginAuth.js'), 'utf8')

  assert.match(source, /if \(id === 'uniopc-socials'\) return 'socials'/)
  assert.match(source, /if \(id === 'uniopc-private-conversion'\) return 'private-conversion'/)
  assert.match(source, /if \(id === 'uniopc-cloud-workspace'\) return 'uniopc-cloud-workspace'/)
  assert.match(source, /function pluginFunctionPath[\s\S]*return ''/)
  assert.match(source, /const functionPath = pluginFunctionPath\(id\)[\s\S]*baseUrl && functionPath/)
  assert.doesNotMatch(source, /imai-socials|imai-private-conversion/)
})

test('migrated Cloud Agent runtimes use Plugins while credential issuance stays on Server Base', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const source = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspacePluginAuth.js'), 'utf8')

  assert.match(source, /export function cloudAgentApiUrl\(pluginId, env = import\.meta\.env \|\| \{\}\)/)
  assert.match(source, /pluginRuntimeApiBaseEnvKey\(id\)/)
  assert.match(source, /export function issueRuntimeTokenUrl\(env = import\.meta\.env \|\| \{\}\)/)
  assert.match(source, /export function issueRuntimeTokenUrl[\s\S]*env\.VITE_SUPABASE_URL[\s\S]*issue-agent-runtime-token/)
})

test('cloud agent authorization distinguishes a missing runtime base from an unloaded catalog route', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const source = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspacePluginAuth.js'), 'utf8')

  assert.match(source, /if \(!String\(runtimeEnv\[requiredKey\] \|\| ''\)\.trim\(\)\)/)
  assert.match(source, /if \(!pluginFunctionPath\(runtimePluginId\)\)/)
  assert.match(source, /缺少 function_path；请刷新应用中心目录后重试。/)
})

test('stale host credentials are repaired by the primary plugin action', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const auth = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspacePluginAuth.js'), 'utf8')
  const hub = fs.readFileSync(path.join(repoRoot, 'src/pages/McpHub.jsx'), 'utf8')

  assert.match(auth, /export function isCloudAgentHostCredentialResetRequiredError/)
  assert.match(auth, /replaceExistingHostCredential = false/)
  assert.match(auth, /payload\?\.code === 'host_credential_already_exists'/)
  assert.match(auth, /requestCredential\(\{ forceReset: true \}\)/)
  assert.match(auth, /message\.includes\('Host Credential 已失效'\)/)
  assert.match(auth, /message\.includes\('invalid_host_credential'\)/)
  assert.match(hub, /isCloudAgentHostCredentialResetRequiredError/)
  assert.match(hub, /replaceExistingHostCredential: true/)
  assert.match(hub, /applySystemPluginSetup\(preset, \{ resetHostCredential: true(?:, \.\.\.connectorRetry)? \}\)/)
  assert.match(hub, /重新授权并启用/)
  assert.doesNotMatch(hub, /setConfirmResetPluginId\(preset\.id\)/)
  assert.doesNotMatch(hub, /需要重置 Host Credential/)
})

test('host credential reset fails fast on expired auth and bounded plugin actions', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const auth = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspacePluginAuth.js'), 'utf8')
  const hub = fs.readFileSync(path.join(repoRoot, 'src/pages/McpHub.jsx'), 'utf8')

  assert.match(auth, /response\.status === 401/)
  assert.match(auth, /payload\?\.code === 'invalid_authorization'/)
  assert.match(auth, /登录状态已过期，请重新登录后再重试插件授权。/)
  assert.match(hub, /PLUGIN_ACTION_TIMEOUT_MS/)
  assert.match(hub, /withPluginActionTimeout/)
  // authEnv 现在包在安装步骤条的 runInstallStep 里，但仍必须被超时兜底。
  assert.match(hub, /withPluginActionTimeout\(\s*currentCloudAgentRuntimeAuthEnv/)
  assert.match(hub, /setPluginActionId\(''\)/)
})

test('host credential issuance uses the bounded trusted Rust network route', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const auth = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspacePluginAuth.js'), 'utf8')
  const rust = fs.readFileSync(path.join(repoRoot, 'src-tauri/src/commands/trusted_network.rs'), 'utf8')

  assert.match(auth, /invoke\('trusted_host_credential_issue'/)
  assert.doesNotMatch(auth, /supabaseFetch\(issueUrl/)
  assert.match(rust, /pub async fn trusted_host_credential_issue/)
  assert.match(rust, /HOST_CREDENTIAL_FUNCTION_PATH/)
  assert.match(rust, /NetworkRoute::Direct/)
})

test('catalog-declared cloud agent plugins replace the dynamic snapshot — new plugins need no desktop change', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const auth = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspacePluginAuth.js'), 'utf8')
  const hub = fs.readFileSync(path.join(repoRoot, 'src/pages/McpHub.jsx'), 'utf8')
  const workspace = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspace.js'), 'utf8')

  // 动态登记表:catalog metadata.function_path → plugin id 映射。
  assert.match(auth, /replaceCloudAgentPluginCatalog/)
  assert.doesNotMatch(auth, /DYNAMIC_FUNCTION_PATH_BY_PLUGIN_ID\.set/)
  // 判定与函数路径都必须先查动态表,再落静态兜底——否则新插件装不上凭据。
  assert.match(auth, /CLOUD_AGENT_PLUGIN_ID_SET\.has\(id\) \|\| isDynamicCloudAgentPluginId\(id\)/)
  assert.match(auth, /const dynamic = dynamicCloudAgentFunctionPath\(id\)/)
  // App Center 只把本次 Rust 在线响应灌表；无签名协议时不得从调用方伪造缓存。
  assert.match(hub, /replaceCloudAgentPluginCatalog\(rows\)/)
  assert.match(hub, /catch \(err\) \{[\s\S]*commitCurrentRequest\(\(\) => \{\s*replaceCloudAgentPluginCatalog\(\[\]\)/)
  // preset 透传 metadata.function_path。
  assert.match(workspace, /metadata\.function_path \|\| metadata\.functionPath/)
})

test('plugins that left the platform-hosted tier are not in the static fallback table', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..')
  const auth = fs.readFileSync(path.join(repoRoot, 'src/lib/cloudWorkspacePluginAuth.js'), 'utf8')
  const consistency = fs.readFileSync(path.join(repoRoot, 'src/lib/profilePluginConsistency.js'), 'utf8')

  // 静态表优先级高于 catalog 动态登记(isCloudAgentPluginId 先查 Set)。插件从
  // 平台托管退回用户自持后若留在表里,会继续被铸 host credential、请求被指向
  // 一个已删除的云函数,而且永远弹不出 api-key 表单。
  // uniopc-wechat-mp 0.2.0 起本机直发微信,已退出该层。
  const staticTable = auth.slice(auth.indexOf('CLOUD_AGENT_PLUGIN_IDS = ['), auth.indexOf(']', auth.indexOf('CLOUD_AGENT_PLUGIN_IDS = [')))
  assert.equal(staticTable.includes("'uniopc-wechat-mp'"), false)
  assert.equal(auth.includes("if (id === 'uniopc-wechat-mp') return 'wechat-mp'"), false)
  assert.equal(consistency.includes("'uniopc-wechat-mp'"), false)
  // 仍在平台托管层的四个必须留着(它们的云函数还在)。
  for (const id of ['uniopc-cloud-workspace', 'uniopc-socials', 'uniopc-private-conversion', 'uniopc-superip']) {
    assert.equal(staticTable.includes(`'${id}'`), true, `${id} 应留在静态兜底表`)
  }
})
