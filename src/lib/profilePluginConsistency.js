import { engineClient } from './engine/client.js'

function normalizePluginId(value) {
  return String(value || '').trim()
}

function normalizeStatus(item = {}) {
  return String(item.status || item.entitlement_status || item.entitlementStatus || 'active').trim() || 'active'
}

export function buildPluginDoctorRequest(bootstrap = {}) {
  return {
    profile: normalizePluginId(bootstrap.openclawProfile || bootstrap.openclaw_profile),
    policyVersion: Number(bootstrap.policyVersion ?? bootstrap.policy_version ?? 0),
    plugins: (Array.isArray(bootstrap.plugins) ? bootstrap.plugins : [])
      .map(plugin => ({
        pluginId: normalizePluginId(plugin.pluginId || plugin.plugin_id || plugin.id),
        status: normalizeStatus(plugin),
        isGlobal: plugin.isGlobal === true || plugin.is_global === true,
      }))
      .filter(plugin => plugin.pluginId),
  }
}

export function shouldRunPluginReconcile(bootstrap = {}, lastAppliedPolicyVersion = 0, report = null) {
  const policyVersion = Number(bootstrap.policyVersion ?? bootstrap.policy_version ?? 0)
  if (policyVersion && policyVersion !== Number(lastAppliedPolicyVersion || 0)) return true
  return String(report?.status || '') === 'needs_repair'
}

export function buildPluginReconcileRequest(bootstrap = {}, cloudAgentAuthByPluginId = {}) {
  const req = buildPluginDoctorRequest(bootstrap)
  return {
    ...req,
    cloudAgentAuth: Object.entries(cloudAgentAuthByPluginId)
      .map(([pluginId, auth]) => ({
        pluginId,
        cloudAgentApiUrl: String(auth?.cloudAgentApiUrl || '').trim(),
        cloudAgentHostCredential: String(auth?.cloudAgentHostCredential || auth?.hostCredential || '').trim(),
      }))
      .filter(item => item.pluginId && item.cloudAgentApiUrl && item.cloudAgentHostCredential),
  }
}

export async function checkProfilePluginConsistency({ client = engineClient, bootstrap }) {
  const req = buildPluginDoctorRequest(bootstrap)
  if (!req.profile) return null
  return await client.plugins.doctorCheck({ req })
}

// 静态兜底表(历史内置插件)。本模块保持零依赖(单测直接 import),所以
// catalog 驱动的动态判定通过 isCloudAgentPlugin 谓词由调用方注入
// (通常传 cloudWorkspacePluginAuth 的 isCloudAgentPluginId)。
const CLOUD_AGENT_PLUGIN_IDS = new Set([
  'uniopc-cloud-workspace',
  'uniopc-socials',
  'uniopc-private-conversion',
])

export async function reconcileProfilePluginConsistency({
  client = engineClient,
  bootstrap,
  authEnvForProfile = null,
  isCloudAgentPlugin = null,
} = {}) {
  const baseReq = buildPluginDoctorRequest(bootstrap)
  if (!baseReq.profile) return null
  const cloudAgentPredicate = typeof isCloudAgentPlugin === 'function'
    ? pluginId => CLOUD_AGENT_PLUGIN_IDS.has(pluginId) || Boolean(isCloudAgentPlugin(pluginId))
    : pluginId => CLOUD_AGENT_PLUGIN_IDS.has(pluginId)
  const desiredCloudAgentPluginIds = baseReq.plugins
    .filter(plugin => plugin.status === 'active')
    .map(plugin => plugin.pluginId)
    .filter(cloudAgentPredicate)
  const cloudAgentAuthByPluginId = {}
  if (desiredCloudAgentPluginIds.length > 0 && typeof authEnvForProfile === 'function') {
    for (const pluginId of desiredCloudAgentPluginIds) {
      const authEnv = await authEnvForProfile({
        profile: baseReq.profile,
        pluginIds: [pluginId],
      })
      cloudAgentAuthByPluginId[pluginId] = authEnv
    }
  }
  const req = buildPluginReconcileRequest(bootstrap, cloudAgentAuthByPluginId)
  if (!req.profile) return null
  return await client.plugins.reconcile({ req })
}

export function subscribeWorkspacePolicyVersion(client, organizationId, onChange) {
  const org = normalizePluginId(organizationId)
  if (!client || !org || typeof onChange !== 'function') return () => {}
  const topic = `workspace-policy:${org}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const channel = client
    .channel(topic)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'cloud_workspace_policy_versions',
        filter: `organization_id=eq.${org}`,
      },
      payload => onChange(payload),
    )
    .subscribe()
  return () => client.removeChannel(channel)
}
