//! Runtime/plugin compatibility ownership for staged cloud plugin installs.
//!
//! The public Tauri command remains in the domain facade. This module owns the
//! artifact decoding, verification, and host compatibility gate that must pass
//! before a stage can be exposed to React for capability review.

use super::{is_safe_plugin_id, normalize_profile, UniopcPluginLifecyclePrepareRequest};
use crate::{
    commands::plugin_lifecycle::{PluginLifecycleError, PluginTrustTier, PreparedPluginInstall},
    services::plugin_artifact::{verify_plugin_archive, PluginArtifactVerificationRequest},
};
use base64::{engine::general_purpose::STANDARD as STANDARD_BASE64, Engine as _};

pub(super) fn prepare_plugin_install(
    req: UniopcPluginLifecyclePrepareRequest,
) -> Result<PreparedPluginInstall, PluginLifecycleError> {
    let plugin_id = req.plugin_id.trim().to_string();
    if !is_safe_plugin_id(&plugin_id) {
        return Err(PluginLifecycleError::artifact(format!(
            "插件 `{plugin_id}` 不支持云端安装。"
        )));
    }
    let bytes = STANDARD_BASE64
        .decode(req.zip_base64.trim())
        .map_err(|err| PluginLifecycleError::artifact(format!("解码插件安装包失败：{err}")))?;
    let artifact = verify_plugin_archive(PluginArtifactVerificationRequest {
        bytes,
        expected_sha256: req.artifact_sha256,
        requested_plugin_id: plugin_id.clone(),
        source_type: "uniopc_official_distributed".to_string(),
    })?;
    let plugin_api_requirement = artifact
        .plugin_api_compatibility
        .declared_requirement
        .clone();
    let host_version = artifact.plugin_api_compatibility.host.to_string();

    Ok(PreparedPluginInstall::reviewed(
        uuid::Uuid::new_v4().to_string(),
        normalize_profile(req.profile.as_deref()),
        plugin_id,
        artifact.sha256,
        artifact.plugin_dir,
        artifact.stage_dir,
        artifact.version,
        artifact.source_type,
        PluginTrustTier::UniopcOfficialDistributed,
        artifact.capability_surface,
        plugin_api_requirement,
        host_version,
    ))
}
