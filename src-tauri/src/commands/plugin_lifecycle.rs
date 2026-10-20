use serde::Serialize;
use std::{collections::HashMap, path::PathBuf, sync::Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginLifecycleLayerState {
    Pending,
    Authorized,
    Verified,
    Configured,
    NotApplicable,
    Blocked,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLifecycleLayer {
    pub state: PluginLifecycleLayerState,
    pub label: String,
    pub detail: Option<String>,
}

impl PluginLifecycleLayer {
    pub fn pending(label: impl Into<String>) -> Self {
        Self {
            state: PluginLifecycleLayerState::Pending,
            label: label.into(),
            detail: None,
        }
    }

    pub fn authorized(label: impl Into<String>) -> Self {
        Self {
            state: PluginLifecycleLayerState::Authorized,
            label: label.into(),
            detail: None,
        }
    }

    pub fn verified(label: impl Into<String>) -> Self {
        Self {
            state: PluginLifecycleLayerState::Verified,
            label: label.into(),
            detail: None,
        }
    }

    pub fn configured(label: impl Into<String>) -> Self {
        Self {
            state: PluginLifecycleLayerState::Configured,
            label: label.into(),
            detail: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCapabilitySurface {
    pub channels: Vec<String>,
    pub providers: Vec<String>,
    pub tools: Vec<String>,
    pub contracts: Vec<String>,
    pub hooks: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub cli_commands: Vec<String>,
    pub cli_backends: Vec<String>,
    pub skills: Vec<String>,
    pub dangerous_config_flags: Vec<String>,
}

impl PluginCapabilitySurface {
    pub fn tools(tools: Vec<String>) -> Self {
        Self {
            tools,
            ..Self::default()
        }
    }

    pub fn is_empty(&self) -> bool {
        self.channels.is_empty()
            && self.providers.is_empty()
            && self.tools.is_empty()
            && self.contracts.is_empty()
            && self.hooks.is_empty()
            && self.mcp_servers.is_empty()
            && self.cli_commands.is_empty()
            && self.cli_backends.is_empty()
            && self.skills.is_empty()
            && self.dangerous_config_flags.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum PluginConsentState {
    Pending { surface: PluginCapabilitySurface },
    Accepted { surface: PluginCapabilitySurface },
    NotRequired,
    Rejected { surface: PluginCapabilitySurface },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginRuntimeState {
    Unverified,
    Ready,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRuntimeLayer {
    pub state: PluginRuntimeState,
    pub tools: Vec<String>,
    pub skills: Vec<String>,
    pub reasons: Vec<String>,
}

impl PluginRuntimeLayer {
    pub fn new(state: PluginRuntimeState) -> Self {
        Self {
            state,
            tools: Vec::new(),
            skills: Vec::new(),
            reasons: Vec::new(),
        }
    }

    pub fn ready(tools: Vec<String>) -> Self {
        Self {
            state: PluginRuntimeState::Ready,
            tools,
            skills: Vec::new(),
            reasons: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLifecycleSnapshot {
    pub profile: String,
    pub plugin_id: String,
    pub entitlement: PluginLifecycleLayer,
    pub artifact: PluginLifecycleLayer,
    pub consent: PluginConsentState,
    pub configuration: PluginLifecycleLayer,
    pub runtime: PluginRuntimeLayer,
    pub browser_access: PluginLifecycleLayer,
    pub usable: bool,
    pub latest_error: Option<PluginLifecycleError>,
}

impl PluginLifecycleSnapshot {
    pub fn new(profile: impl Into<String>, plugin_id: impl Into<String>) -> Self {
        Self {
            profile: profile.into(),
            plugin_id: plugin_id.into(),
            entitlement: PluginLifecycleLayer::pending("Entitlement pending"),
            artifact: PluginLifecycleLayer::pending("Artifact pending"),
            consent: PluginConsentState::Pending {
                surface: PluginCapabilitySurface::default(),
            },
            configuration: PluginLifecycleLayer::pending("Configuration pending"),
            runtime: PluginRuntimeLayer::new(PluginRuntimeState::Unverified),
            browser_access: PluginLifecycleLayer {
                state: PluginLifecycleLayerState::NotApplicable,
                label: "Browser access not required".to_string(),
                detail: None,
            },
            usable: false,
            latest_error: None,
        }
    }

    pub fn is_usable(&self) -> bool {
        self.entitlement.state == PluginLifecycleLayerState::Authorized
            && self.artifact.state == PluginLifecycleLayerState::Verified
            && matches!(
                self.consent,
                PluginConsentState::Accepted { .. } | PluginConsentState::NotRequired
            )
            && self.configuration.state == PluginLifecycleLayerState::Configured
            && self.runtime.state == PluginRuntimeState::Ready
    }

    pub fn refresh_usable(&mut self) {
        self.usable = self.is_usable();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLifecycleError {
    pub code: String,
    pub layer: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_api_requirement: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_version: Option<String>,
}

impl PluginLifecycleError {
    pub fn artifact(message: impl Into<String>) -> Self {
        Self {
            code: "plugin_artifact_invalid".to_string(),
            layer: "artifact".to_string(),
            message: message.into(),
            retryable: false,
            plugin_api_requirement: None,
            host_version: None,
        }
    }

    pub fn plugin_api_incompatible(
        message: impl Into<String>,
        requirement: Option<String>,
        host_version: Option<String>,
    ) -> Self {
        Self {
            code: "plugin_api_incompatible".to_string(),
            layer: "artifact".to_string(),
            message: message.into(),
            retryable: false,
            plugin_api_requirement: requirement,
            host_version,
        }
    }
}

impl From<String> for PluginLifecycleError {
    fn from(message: String) -> Self {
        Self::artifact(message)
    }
}

impl std::fmt::Display for PluginLifecycleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginTrustTier {
    UniopcOfficialDistributed,
    ThirdPartyOrCustom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginArtifactReview {
    pub stage_id: String,
    pub plugin_id: String,
    pub artifact_sha256: String,
    pub version: Option<String>,
    pub source_type: String,
    pub trust_tier: PluginTrustTier,
    pub capability_surface: PluginCapabilitySurface,
    pub plugin_api_requirement: String,
    pub host_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedPluginInstall {
    pub stage_id: String,
    pub profile: String,
    pub plugin_id: String,
    pub artifact_sha256: String,
    pub source_dir: Option<PathBuf>,
    pub stage_dir: Option<PathBuf>,
    pub review: Option<PluginArtifactReview>,
}

impl PreparedPluginInstall {
    pub fn new(
        stage_id: impl Into<String>,
        profile: impl Into<String>,
        plugin_id: impl Into<String>,
        artifact_sha256: impl Into<String>,
    ) -> Self {
        Self {
            stage_id: stage_id.into(),
            profile: profile.into(),
            plugin_id: plugin_id.into(),
            artifact_sha256: artifact_sha256.into(),
            source_dir: None,
            stage_dir: None,
            review: None,
        }
    }

    pub fn reviewed(
        stage_id: impl Into<String>,
        profile: impl Into<String>,
        plugin_id: impl Into<String>,
        artifact_sha256: impl Into<String>,
        source_dir: PathBuf,
        stage_dir: PathBuf,
        version: Option<String>,
        source_type: impl Into<String>,
        trust_tier: PluginTrustTier,
        capability_surface: PluginCapabilitySurface,
        plugin_api_requirement: String,
        host_version: String,
    ) -> Self {
        let stage_id = stage_id.into();
        let plugin_id = plugin_id.into();
        let artifact_sha256 = artifact_sha256.into();
        let review = PluginArtifactReview {
            stage_id: stage_id.clone(),
            plugin_id: plugin_id.clone(),
            artifact_sha256: artifact_sha256.clone(),
            version,
            source_type: source_type.into(),
            trust_tier,
            capability_surface,
            plugin_api_requirement,
            host_version,
        };
        Self {
            stage_id,
            profile: profile.into(),
            plugin_id,
            artifact_sha256,
            source_dir: Some(source_dir),
            stage_dir: Some(stage_dir),
            review: Some(review),
        }
    }
}

#[derive(Default)]
pub struct PluginLifecycleStaging {
    installs: Mutex<HashMap<String, PreparedPluginInstall>>,
}

impl PluginLifecycleStaging {
    pub fn insert(&self, prepared: PreparedPluginInstall) {
        self.installs
            .lock()
            .expect("plugin lifecycle staging lock poisoned")
            .insert(prepared.stage_id.clone(), prepared);
    }

    pub fn get_for(
        &self,
        stage_id: &str,
        profile: &str,
        plugin_id: &str,
    ) -> Option<PreparedPluginInstall> {
        self.installs
            .lock()
            .expect("plugin lifecycle staging lock poisoned")
            .get(stage_id)
            .filter(|prepared| prepared.profile == profile && prepared.plugin_id == plugin_id)
            .cloned()
    }

    pub fn get_for_hash(
        &self,
        stage_id: &str,
        profile: &str,
        plugin_id: &str,
        artifact_sha256: &str,
    ) -> Option<PreparedPluginInstall> {
        self.get_for(stage_id, profile, plugin_id)
            .filter(|prepared| prepared.artifact_sha256 == artifact_sha256)
    }

    pub fn remove_for(
        &self,
        stage_id: &str,
        profile: &str,
        plugin_id: &str,
    ) -> Option<PreparedPluginInstall> {
        let mut installs = self
            .installs
            .lock()
            .expect("plugin lifecycle staging lock poisoned");
        let matches_scope = installs
            .get(stage_id)
            .is_some_and(|prepared| prepared.profile == profile && prepared.plugin_id == plugin_id);

        matches_scope.then(|| installs.remove(stage_id)).flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        PluginCapabilitySurface, PluginConsentState, PluginLifecycleLayer, PluginLifecycleSnapshot,
        PluginLifecycleStaging, PluginRuntimeLayer, PluginRuntimeState, PreparedPluginInstall,
    };

    fn configured_layer() -> PluginLifecycleLayer {
        PluginLifecycleLayer::configured("Configured")
    }

    #[test]
    fn snapshot_is_usable_only_after_every_required_layer_is_ready() {
        let mut snapshot = PluginLifecycleSnapshot::new("default", "uniopc-montage");
        snapshot.entitlement = PluginLifecycleLayer::authorized("Authorized");
        snapshot.artifact = PluginLifecycleLayer::verified("Artifact verified");
        snapshot.configuration = configured_layer();
        snapshot.runtime = PluginRuntimeLayer::ready(vec!["montage_create".to_string()]);

        snapshot.consent = PluginConsentState::Pending {
            surface: PluginCapabilitySurface::tools(vec!["montage_create".to_string()]),
        };
        assert!(!snapshot.is_usable());

        snapshot.consent = PluginConsentState::Accepted {
            surface: PluginCapabilitySurface::tools(vec!["montage_create".to_string()]),
        };
        assert!(snapshot.is_usable());
    }

    #[test]
    fn runtime_unverified_is_never_usable_even_when_the_config_is_enabled() {
        let mut snapshot = PluginLifecycleSnapshot::new("default", "uniopc-montage");
        snapshot.entitlement = PluginLifecycleLayer::authorized("Authorized");
        snapshot.artifact = PluginLifecycleLayer::verified("Artifact verified");
        snapshot.configuration = configured_layer();
        snapshot.consent = PluginConsentState::NotRequired;
        snapshot.runtime = PluginRuntimeLayer::new(PluginRuntimeState::Unverified);

        assert!(!snapshot.is_usable());
    }

    #[test]
    fn staged_install_is_scoped_to_its_profile_and_plugin() {
        let staging = PluginLifecycleStaging::default();
        let prepared =
            PreparedPluginInstall::new("stage-1", "sales-owner", "uniopc-montage", "aabbcc");

        staging.insert(prepared);

        assert!(staging
            .get_for("stage-1", "sales-owner", "uniopc-montage")
            .is_some());
        assert!(staging
            .get_for("stage-1", "other-profile", "uniopc-montage")
            .is_none());
        assert!(staging
            .get_for_hash("stage-1", "sales-owner", "uniopc-montage", "aabbcc")
            .is_some());
        assert!(staging
            .get_for_hash("stage-1", "sales-owner", "uniopc-montage", "different")
            .is_none());
    }
}
