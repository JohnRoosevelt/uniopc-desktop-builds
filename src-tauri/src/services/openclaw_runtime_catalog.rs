use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const OPENCLAW_RELEASE_NODE_VERSION: &str = "24.19.0";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeArtifact {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub archive: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub node_version: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeCatalog {
    pub artifacts: Vec<RuntimeArtifact>,
}

pub fn select_runtime_artifact<'a>(
    catalog: &'a RuntimeCatalog,
    platform: &str,
    arch: &str,
) -> Result<&'a RuntimeArtifact, String> {
    catalog
        .artifacts
        .iter()
        .find(|artifact| artifact.platform == platform && artifact.arch == arch)
        .ok_or_else(|| format!("未找到 {platform}-{arch} 的内置 Uniopc 引擎制品。"))
}

pub fn verify_archive_bytes(artifact: &RuntimeArtifact, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != artifact.size_bytes {
        return Err("内置运行时大小校验失败。".to_string());
    }
    let actual_sha256 = hex::encode(Sha256::digest(bytes));
    if actual_sha256 != artifact.sha256.trim().to_ascii_lowercase() {
        return Err("内置运行时 SHA-256 校验失败。".to_string());
    }
    Ok(())
}

pub fn node_version_is_supported(value: &str) -> bool {
    value.trim().trim_start_matches('v') == OPENCLAW_RELEASE_NODE_VERSION
}

#[cfg(test)]
mod tests {
    use super::{
        node_version_is_supported, select_runtime_artifact, verify_archive_bytes, RuntimeArtifact,
        RuntimeCatalog,
    };

    fn test_artifact() -> RuntimeArtifact {
        RuntimeArtifact {
            version: "2026.8.1".to_string(),
            platform: "darwin".to_string(),
            arch: "arm64".to_string(),
            archive: "uniopc-engine-runtime-darwin-arm64.tar.gz".to_string(),
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".to_string(),
            size_bytes: 5,
            node_version: "24.19.0".to_string(),
        }
    }

    #[test]
    fn selects_only_the_running_target() {
        let catalog = RuntimeCatalog {
            artifacts: vec![test_artifact()],
        };

        assert_eq!(
            select_runtime_artifact(&catalog, "darwin", "arm64")
                .unwrap()
                .archive,
            "uniopc-engine-runtime-darwin-arm64.tar.gz"
        );
        assert!(select_runtime_artifact(&catalog, "darwin", "x64").is_err());
    }

    #[test]
    fn rejects_archive_when_sha256_or_size_differs() {
        let artifact = test_artifact();

        assert!(verify_archive_bytes(&artifact, b"wrong").is_err());
        assert!(verify_archive_bytes(&artifact, b"hello").is_ok());
    }

    #[test]
    fn accepts_only_the_exact_release_node_version() {
        assert!(node_version_is_supported("v24.19.0"));
        assert!(node_version_is_supported("24.19.0"));
        assert!(!node_version_is_supported("24.18.0"));
        assert!(!node_version_is_supported("24.19.1"));
        assert!(!node_version_is_supported("25.0.0"));
    }
}
