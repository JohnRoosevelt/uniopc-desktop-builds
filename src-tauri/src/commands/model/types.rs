use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct OpenClawStatus {
    pub installed: bool,
    pub supported: bool,
    pub platform: String,
    pub message: String,
    pub setup_stage: String,
    pub provider_ready: bool,
    pub provider_mode: Option<String>,
    pub app_ready: bool,
    pub version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: Option<bool>,
    pub update_message: Option<String>,
    pub runtime_cleanup_warning: Option<String>,
    pub binary_path: Option<String>,
    pub node_version: Option<String>,
    pub dashboard_url: String,
    pub gateway_ws_url: String,
    pub gateway_running: bool,
    pub gateway_rpc_ok: bool,
    pub gateway_status_message: Option<String>,
    pub gateway_device_id: Option<String>,
    pub gateway_public_key: Option<String>,
    pub default_model: Option<String>,
    pub resolved_default_model: Option<String>,
    pub auth_profile_labels: Vec<String>,
    pub runtime_compat_ready: bool,
    pub runtime_compat_message: Option<String>,
    pub install_command: String,
    pub update_command: String,
    pub uninstall_command: String,
    /// Redacted proxy summary for the runtime diagnostics page.
    pub proxy_summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenClawSetupProgress {
    pub phase: String,
    pub status: String,
    pub detail: Option<String>,
    pub output_tail: Option<String>,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenClawInstallResult {
    pub status: OpenClawStatus,
    pub output_tail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProviderApiKeyRequest {
    pub provider: String,
    pub api_key: String,
    pub model: Option<String>,
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawUniopcOfficialRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: Option<String>,
    pub profile: Option<String>,
    /// Official chat model catalog from mint-llm-token's `models[]`: every id
    /// gets registered under the `uniopc-official` provider (all routed through
    /// the same loopback proxy). Optional — older callers omit it and only the
    /// default model is registered. Display-only metadata (tier/badge/
    /// multiplier) stays on the JS side; serde ignores those extra fields.
    #[serde(default)]
    pub models: Option<Vec<OpenClawOfficialCatalogModel>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawOfficialCatalogModel {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// Capabilities DECLARED by the catalog row (mint-llm-token), transcribed
    /// verbatim into the gateway model entry. Never re-derive these from the
    /// id: the alias is operator-editable in the admin console, so guessing
    /// silently drops image input the moment a row is renamed.
    #[serde(default)]
    pub supports_vision: Option<bool>,
    #[serde(default)]
    pub supports_reasoning: Option<bool>,
    /// Per upstream family; empty/absent means "read `reasoning_content` off
    /// the response" rather than injecting a request parameter.
    #[serde(default)]
    pub thinking_format: Option<String>,
}

/// A user-supplied OpenAI-compatible endpoint (their own key, their own
/// upstream). Unlike the preset providers in `provider_api_key_spec`, the
/// provider id here is derived from the label, so several custom endpoints can
/// coexist without colliding.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawCustomModelRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawMediaCapabilitiesSaveRequest {
    pub profile: Option<String>,
    pub image_model: Option<String>,
    pub video_model: Option<String>,
    pub tts_model: Option<String>,
    pub tts_voice: Option<String>,
    pub stt_model: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct ProviderApiKeySpec {
    pub(super) provider_prefix: &'static str,
    pub(super) env_key: &'static str,
    pub(super) default_model: &'static str,
    pub(super) auth_choice: Option<&'static str>,
    pub(super) required_key_prefix: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenClawModelStatus {
    pub default_model: Option<String>,
    pub resolved_default_model: Option<String>,
    pub provider_ready: bool,
    pub provider_mode: Option<String>,
    pub missing_providers_in_use: Vec<String>,
    pub providers_with_oauth: Vec<String>,
    pub auth_profile_labels: Vec<String>,
    pub runtime_compat_ready: bool,
    pub runtime_compat_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawModelCatalogEntry {
    pub model_ref: String,
    pub provider: String,
    pub model: String,
    pub display_name: String,
    pub configured: bool,
    pub catalog_available: bool,
    pub provider_ready: bool,
    pub provider_status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProviderSnapshot {
    pub id: String,
    pub label: String,
    pub auth_kind: String,
    /// The provider block exists in config (has an apiKey/baseUrl), regardless
    /// of runtime auth `ready`. Lets the UI tell "set up but not yet
    /// authenticated" from "provider block missing/wiped".
    pub configured: bool,
    pub ready: bool,
    pub status: Option<String>,
    pub auth_profiles: Vec<String>,
    pub recommended_model: Option<String>,
    pub login_supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawModelsSnapshot {
    pub primary_model: Option<String>,
    pub resolved_default_model: Option<String>,
    pub fallback_models: Vec<String>,
    pub image_generation_model: Option<String>,
    pub video_generation_model: Option<String>,
    pub tts_model: Option<String>,
    pub tts_voice: Option<String>,
    pub stt_model: Option<String>,
    pub models: Vec<OpenClawModelCatalogEntry>,
    pub providers: Vec<OpenClawProviderSnapshot>,
    pub auth_profile_labels: Vec<String>,
    pub runtime_compat_ready: bool,
    pub runtime_compat_message: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct OpenClawGatewayStatus {
    pub(super) running: bool,
    pub(super) rpc_ok: bool,
    pub(super) health_ok: bool,
    pub(super) rpc_blocked: bool,
    pub(super) message: Option<String>,
    pub(super) dashboard_url: String,
    pub(super) ws_url: String,
    pub(super) device_id: Option<String>,
    pub(super) public_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfileProvisionRequest {
    pub profile: String,
    pub gateway_port: Option<u16>,
    #[serde(default, alias = "managed_member_profile")]
    pub managed_member_profile: bool,
    pub cloud_agent_api_url: Option<String>,
    pub cloud_agent_auth_token: Option<String>,
    pub cloud_agent_token_expires_at: Option<String>,
    pub cloud_agent_id: Option<String>,
    #[serde(skip)]
    pub(crate) startup_generation: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfileProvisionResult {
    pub profile: String,
    pub host_name: String,
    pub gateway_port: u16,
    pub gateway_url: String,
    pub dashboard_url: String,
    pub gateway_status: String,
    pub output_tail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfileStatusRequest {
    pub profile: String,
    pub gateway_port: Option<u16>,
    #[serde(default, alias = "managed_member_profile")]
    pub managed_member_profile: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenClawProfileStatusResult {
    pub profile: String,
    pub profile_exists: bool,
    pub host_name: String,
    pub gateway_port: u16,
    pub gateway_url: String,
    pub dashboard_url: String,
    pub gateway_running: bool,
    pub gateway_rpc_ok: bool,
    pub gateway_status: String,
    pub provider_ready: bool,
    pub provider_mode: Option<String>,
    pub default_model: Option<String>,
    pub resolved_default_model: Option<String>,
    pub runtime_compat_ready: bool,
    pub runtime_compat_message: Option<String>,
    pub message: Option<String>,
}
