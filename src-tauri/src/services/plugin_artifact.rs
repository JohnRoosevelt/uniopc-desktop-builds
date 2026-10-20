use crate::commands::plugin_lifecycle::{PluginCapabilitySurface, PluginLifecycleError};
use crate::services::openclaw_engine_contract::OPENCLAW_ENGINE_VERSION;
use semver::{Version, VersionReq};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Cursor},
    path::{Path, PathBuf},
};

/// Resolve without modifying existing user plugins. New managed imports are
/// normalized separately after archive integrity verification.
pub fn plugin_manifest_path(root: &Path) -> PathBuf {
    let branded = root.join("uniopc.plugin.json");
    if branded.is_file() { branded } else {
        let legacy = root.join("openclaw.plugin.json");
        if legacy.is_file() { legacy } else { branded }
    }
}

fn normalize_staged_plugin_manifest(root: &Path) -> Result<(), String> {
    let legacy = root.join("openclaw.plugin.json");
    let branded = root.join("uniopc.plugin.json");
    if legacy.exists() && branded.exists() {
        return Err("插件安装包同时包含新旧清单，拒绝导入。".to_string());
    }
    if legacy.is_file() {
        fs::rename(&legacy, &branded).map_err(|error| format!("转换插件清单失败：{error}"))?;
    }
    Ok(())
}

#[derive(Debug)]
pub struct PluginArtifactVerificationRequest {
    pub bytes: Vec<u8>,
    pub expected_sha256: String,
    pub requested_plugin_id: String,
    pub source_type: String,
}

#[derive(Debug)]
pub struct VerifiedPluginArtifact {
    pub stage_dir: PathBuf,
    pub plugin_dir: PathBuf,
    pub manifest: Value,
    pub capability_surface: PluginCapabilitySurface,
    pub sha256: String,
    pub source_type: String,
    pub version: Option<String>,
    pub plugin_api_compatibility: PluginApiCompatibility,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginApiCompatibility {
    pub requirement: VersionReq,
    pub declared_requirement: String,
    pub host: Version,
}

const MAX_PLUGIN_API_REQUIREMENT_BYTES: usize = 256;

impl VerifiedPluginArtifact {
    pub fn cleanup(&self) -> Result<(), String> {
        if self.stage_dir.exists() {
            fs::remove_dir_all(&self.stage_dir).map_err(|error| {
                format!(
                    "移除插件安装暂存目录 {} 失败：{error}",
                    self.stage_dir.to_string_lossy()
                )
            })?;
        }
        Ok(())
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn verify_plugin_archive(
    request: PluginArtifactVerificationRequest,
) -> Result<VerifiedPluginArtifact, PluginLifecycleError> {
    let requested_plugin_id = request.requested_plugin_id.trim();
    if requested_plugin_id.is_empty() {
        return Err(PluginLifecycleError::artifact(
            "插件安装请求缺少 plugin_id。",
        ));
    }
    let expected_sha256 = request.expected_sha256.trim().to_lowercase();
    if expected_sha256.is_empty() {
        return Err(PluginLifecycleError::artifact(
            "缺少插件安装包校验值 artifact_sha256。",
        ));
    }
    let actual_sha256 = sha256_hex(&request.bytes);
    if actual_sha256 != expected_sha256 {
        return Err(PluginLifecycleError::artifact(format!(
            "插件安装包校验失败：expected {expected_sha256}, got {actual_sha256}。"
        )));
    }

    let stage_dir = std::env::temp_dir().join(format!(
        "uniopc-plugin-review-{}-{}",
        requested_plugin_id,
        uuid::Uuid::new_v4()
    ));
    let verified: Result<VerifiedPluginArtifact, PluginLifecycleError> = (|| {
        extract_plugin_archive(&request.bytes, &stage_dir)?;
        let plugin_dir = find_plugin_root(&stage_dir)?;
        normalize_staged_plugin_manifest(&plugin_dir)?;
        let manifest = read_manifest(&plugin_dir)?;
        let manifest_id = manifest_string(&manifest, "id")
            .ok_or_else(|| PluginLifecycleError::artifact("插件 manifest 缺少 id。"))?;
        if manifest_id != requested_plugin_id {
            return Err(PluginLifecycleError::artifact(format!(
                "插件安装包 manifest id `{manifest_id}` 与请求的 `{requested_plugin_id}` 不一致。"
            )));
        }
        let plugin_api_compatibility = read_plugin_api_compatibility(&plugin_dir)?;
        let capability_surface = capability_surface_from_manifest(&manifest);
        let version = manifest_string(&manifest, "version");
        Ok(VerifiedPluginArtifact {
            stage_dir: stage_dir.clone(),
            plugin_dir,
            manifest,
            capability_surface,
            sha256: actual_sha256,
            source_type: request.source_type.trim().to_string(),
            version,
            plugin_api_compatibility,
        })
    })();

    if verified.is_err() {
        let _ = fs::remove_dir_all(&stage_dir);
    }
    verified
}

fn read_plugin_api_compatibility(
    plugin_dir: &Path,
) -> Result<PluginApiCompatibility, PluginLifecycleError> {
    let host = Version::parse(OPENCLAW_ENGINE_VERSION).map_err(|_| {
        PluginLifecycleError::plugin_api_incompatible(
            "当前本地服务版本无法用于插件兼容性检查。",
            None,
            Some(OPENCLAW_ENGINE_VERSION.to_string()),
        )
    })?;
    let package_path = plugin_dir.join("package.json");
    let package_raw = fs::read_to_string(&package_path).map_err(|_| {
        PluginLifecycleError::plugin_api_incompatible(
            "插件缺少引擎兼容声明（package.json 中的 compat.pluginApi）。",
            None,
            Some(host.to_string()),
        )
    })?;
    let package: Value = serde_json::from_str(&package_raw).map_err(|_| {
        PluginLifecycleError::plugin_api_incompatible(
            "插件的引擎兼容声明格式无效。",
            None,
            Some(host.to_string()),
        )
    })?;
    let requirement_raw = package
        .pointer("/openclaw/compat/pluginApi")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            PluginLifecycleError::plugin_api_incompatible(
                "插件缺少引擎兼容声明（package.json 中的 compat.pluginApi）。",
                None,
                Some(host.to_string()),
            )
        })?;
    let (requirement, declared_requirement) = parse_plugin_api_requirement(requirement_raw)
        .map_err(|_| {
            PluginLifecycleError::plugin_api_incompatible(
                "插件的引擎兼容声明格式无效。",
                None,
                Some(host.to_string()),
            )
        })?;
    if !requirement.matches(&host) {
        return Err(PluginLifecycleError::plugin_api_incompatible(
            "插件要求的本地服务 API 版本与当前版本不兼容。",
            Some(declared_requirement),
            Some(host.to_string()),
        ));
    }

    Ok(PluginApiCompatibility {
        requirement,
        declared_requirement,
        host,
    })
}

fn parse_plugin_api_requirement(raw: &str) -> Result<(VersionReq, String), ()> {
    if raw.len() > MAX_PLUGIN_API_REQUIREMENT_BYTES || raw.contains("||") {
        return Err(());
    }
    let tokens = raw.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return Err(());
    }

    let mut normalized = Vec::with_capacity(tokens.len());
    for token in &tokens {
        if token.contains([',', '|']) {
            return Err(());
        }
        let (operator, target) = [">=", "<=", ">", "<", "=", "^", "~"]
            .into_iter()
            .find_map(|operator| {
                token
                    .strip_prefix(operator)
                    .map(|target| (operator, target))
            })
            .unwrap_or(("", token));
        if target.is_empty() || target.starts_with(['<', '>', '=', '^', '~']) {
            return Err(());
        }

        let target = target
            .strip_prefix('v')
            .or_else(|| target.strip_prefix('V'))
            .unwrap_or(target);
        let parts = target.split('.').collect::<Vec<_>>();
        let is_partial = parts.len() == 2
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
        let target = if is_partial {
            format!("{target}.0")
        } else {
            target.to_string()
        };
        let operator = if operator.is_empty() {
            if is_partial {
                ">="
            } else {
                "="
            }
        } else {
            operator
        };
        let comparator = format!("{operator}{target}");
        VersionReq::parse(&comparator).map_err(|_| ())?;
        normalized.push(comparator);
    }

    let requirement = VersionReq::parse(&normalized.join(", ")).map_err(|_| ())?;
    Ok((requirement, tokens.join(" ")))
}

fn extract_plugin_archive(bytes: &[u8], stage_dir: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("读取插件安装包失败：{error}"))?;
    fs::create_dir_all(stage_dir).map_err(|error| {
        format!(
            "创建插件安装暂存目录 {} 失败：{error}",
            stage_dir.to_string_lossy()
        )
    })?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取插件安装包条目失败：{error}"))?;
        let relative_path = entry
            .enclosed_name()
            .ok_or_else(|| "插件安装包包含不安全的文件路径。".to_string())?
            .to_path_buf();
        let destination = stage_dir.join(relative_path);
        if entry.is_dir() {
            fs::create_dir_all(&destination).map_err(|error| {
                format!(
                    "创建插件目录 {} 失败：{error}",
                    destination.to_string_lossy()
                )
            })?;
            continue;
        }
        let parent = destination
            .parent()
            .ok_or_else(|| "插件安装包包含无效的文件路径。".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建插件目录 {} 失败：{error}", parent.to_string_lossy()))?;
        let mut output = fs::File::create(&destination).map_err(|error| {
            format!(
                "写入插件文件 {} 失败：{error}",
                destination.to_string_lossy()
            )
        })?;
        io::copy(&mut entry, &mut output).map_err(|error| {
            format!(
                "解压插件文件 {} 失败：{error}",
                destination.to_string_lossy()
            )
        })?;
    }
    Ok(())
}

fn find_plugin_root(stage_dir: &Path) -> Result<PathBuf, String> {
    let mut roots = Vec::new();
    find_plugin_roots(stage_dir, &mut roots)?;
    match roots.len() {
        1 => Ok(roots.remove(0)),
        0 => Err("插件安装包中缺少 uniopc.plugin.json。".to_string()),
        _ => Err("插件安装包包含多个插件清单，无法确定要安装的插件。".to_string()),
    }
}

fn find_plugin_roots(directory: &Path, roots: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in
        fs::read_dir(directory).map_err(|error| format!("读取插件安装包目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取插件安装包目录项失败：{error}"))?;
        let path = entry.path();
        if path.is_dir() {
            if plugin_manifest_path(&path).is_file() {
                roots.push(path);
            } else {
                find_plugin_roots(&path, roots)?;
            }
        }
    }
    if plugin_manifest_path(directory).is_file() {
        roots.push(directory.to_path_buf());
    }
    Ok(())
}

fn read_manifest(plugin_dir: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(plugin_manifest_path(plugin_dir))
        .map_err(|error| format!("读取插件 manifest 失败：{error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("解析插件 manifest 失败：{error}"))
}

fn manifest_string(manifest: &Value, key: &str) -> Option<String> {
    manifest
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalized_values(values: impl IntoIterator<Item = String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

pub fn capability_surface_from_manifest(manifest: &Value) -> PluginCapabilitySurface {
    let channels = string_array(manifest.get("channels"));
    let channels = if channels.is_empty() {
        manifest
            .get("channel")
            .and_then(|channel| channel.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .into_iter()
            .collect()
    } else {
        channels
    };
    let providers: Vec<String> = manifest
        .get("providers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|provider| match provider {
            Value::String(value) => Some(value.clone()),
            Value::Object(_) => provider
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .collect();
    let contracts_object = manifest.get("contracts").and_then(Value::as_object);
    let contract_values = contracts_object
        .into_iter()
        .flat_map(|contracts| contracts.iter())
        .flat_map(|(family, values)| {
            string_array(Some(values))
                .into_iter()
                .map(move |id| format!("{family}: {id}"))
        })
        .collect::<Vec<_>>();
    let contract_tools = contracts_object
        .and_then(|contracts| contracts.get("tools"))
        .map(|value| string_array(Some(value)))
        .unwrap_or_default();
    let metadata_tools = manifest
        .get("toolMetadata")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|metadata| metadata.keys().cloned())
        .collect::<Vec<_>>();
    let mcp_servers = manifest
        .get("mcpServers")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|servers| servers.keys().cloned())
        .collect::<Vec<_>>();
    let cli_commands: Vec<String> = manifest
        .get("cliCommands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|command| match command {
            Value::String(value) => Some(value.clone()),
            Value::Object(_) => command
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .collect();
    let dangerous_config_flags: Vec<String> = manifest
        .get("configContracts")
        .and_then(|contracts| contracts.get("dangerousFlags"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|flag| match flag {
            Value::String(value) => Some(value.clone()),
            Value::Object(_) => flag.get("path").and_then(Value::as_str).map(str::to_string),
            _ => None,
        })
        .collect();

    PluginCapabilitySurface {
        channels: normalized_values(channels),
        providers: normalized_values(providers),
        tools: normalized_values(contract_tools.into_iter().chain(metadata_tools)),
        contracts: normalized_values(contract_values),
        hooks: normalized_values(string_array(manifest.get("hooks"))),
        mcp_servers: normalized_values(mcp_servers),
        cli_commands: normalized_values(cli_commands),
        cli_backends: normalized_values(string_array(manifest.get("cliBackends"))),
        skills: normalized_values(string_array(manifest.get("skills"))),
        dangerous_config_flags: normalized_values(dangerous_config_flags),
    }
}

#[cfg(test)]
mod tests {
    use super::{sha256_hex, verify_plugin_archive, PluginArtifactVerificationRequest};
    use std::io::{Cursor, Write};
    use zip::{write::SimpleFileOptions, ZipWriter};

    #[test]
    fn managed_manifest_normalization_preserves_legacy_reads_and_rejects_collisions() {
        let root = std::env::temp_dir().join(format!("uniopc-manifest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let legacy = root.join("openclaw.plugin.json");
        let branded = root.join("uniopc.plugin.json");
        std::fs::write(&legacy, "{\"id\":\"keep\"}").unwrap();
        assert_eq!(super::plugin_manifest_path(&root), legacy);
        assert!(legacy.is_file()); // compatibility reads never mutate user data
        super::normalize_staged_plugin_manifest(&root).unwrap();
        assert!(!legacy.exists());
        assert_eq!(super::plugin_manifest_path(&root), branded);
        super::normalize_staged_plugin_manifest(&root).unwrap();
        std::fs::write(&legacy, "conflict").unwrap();
        assert!(super::normalize_staged_plugin_manifest(&root).is_err());
        assert_eq!(std::fs::read_to_string(&branded).unwrap(), "{\"id\":\"keep\"}");
        std::fs::remove_dir_all(root).unwrap();
    }

    fn fixture_zip_with_package(manifest: &str, package_json: Option<&str>) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("package/openclaw.plugin.json", SimpleFileOptions::default())
            .expect("start manifest entry");
        writer
            .write_all(manifest.as_bytes())
            .expect("write manifest");
        if let Some(package_json) = package_json {
            writer
                .start_file("package/package.json", SimpleFileOptions::default())
                .expect("start package metadata entry");
            writer
                .write_all(package_json.as_bytes())
                .expect("write package metadata");
        }
        writer
            .start_file("package/index.js", SimpleFileOptions::default())
            .expect("start plugin entry");
        writer
            .write_all(b"export default {};")
            .expect("write plugin entry");
        writer.finish().expect("finish fixture").into_inner()
    }

    fn fixture_zip(manifest: &str) -> Vec<u8> {
        fixture_zip_with_package(
            manifest,
            Some(r#"{"openclaw":{"compat":{"pluginApi":">=2026.8.1"}}}"#),
        )
    }

    #[test]
    fn verified_artifact_builds_the_exact_openclaw_review_surface() {
        let bytes = fixture_zip(
            r#"{
              "id":"smart-montage",
              "channels":[" channel-z ","channel-a","channel-a"],
              "providers":["provider-z",{"id":"provider-a"}],
              "contracts":{"tools":["montage.create"],"documentExtractors":["extract-pdf"]},
              "toolMetadata":{"montage.describe":{}},
              "hooks":["hook-z","hook-a"],
              "mcpServers":{"design":{}},
              "cliCommands":[{"name":"montage"}],
              "cliBackends":["montage-cli"],
              "skills":[" smart-montage ","smart-montage"],
              "configContracts":{"dangerousFlags":[{"path":"plugins.smart-montage.allowShell"}]}
            }"#,
        );
        let expected_sha256 = sha256_hex(&bytes);
        let artifact = verify_plugin_archive(PluginArtifactVerificationRequest {
            bytes,
            expected_sha256,
            requested_plugin_id: "smart-montage".to_string(),
            source_type: "uniopc_official_distributed".to_string(),
        })
        .expect("fixture must verify");

        assert_eq!(
            artifact.capability_surface.channels,
            vec!["channel-a", "channel-z"]
        );
        assert_eq!(
            artifact.capability_surface.providers,
            vec!["provider-a", "provider-z"]
        );
        assert_eq!(
            artifact.capability_surface.tools,
            vec!["montage.create", "montage.describe"]
        );
        assert_eq!(
            artifact.capability_surface.contracts,
            vec!["documentExtractors: extract-pdf", "tools: montage.create"]
        );
        assert_eq!(artifact.capability_surface.hooks, vec!["hook-a", "hook-z"]);
        assert_eq!(artifact.capability_surface.mcp_servers, vec!["design"]);
        assert_eq!(artifact.capability_surface.cli_commands, vec!["montage"]);
        assert_eq!(
            artifact.capability_surface.cli_backends,
            vec!["montage-cli"]
        );
        assert_eq!(artifact.capability_surface.skills, vec!["smart-montage"]);
        assert_eq!(
            artifact.capability_surface.dangerous_config_flags,
            vec!["plugins.smart-montage.allowShell"]
        );

        assert!(artifact.plugin_dir.join("uniopc.plugin.json").is_file());
        assert!(!artifact.plugin_dir.join("openclaw.plugin.json").exists());
        artifact.cleanup().expect("stage cleanup");
    }

    #[test]
    fn artifact_rejects_sha_mismatch_before_extraction() {
        let bytes = fixture_zip(r#"{"id":"smart-montage"}"#);
        let error = verify_plugin_archive(PluginArtifactVerificationRequest {
            bytes,
            expected_sha256: "not-the-real-hash".to_string(),
            requested_plugin_id: "smart-montage".to_string(),
            source_type: "uniopc_official_distributed".to_string(),
        })
        .expect_err("wrong hash must fail");

        assert_eq!(error.code, "plugin_artifact_invalid");
        assert!(error.message.contains("校验失败"));
    }

    #[test]
    fn artifact_rejects_missing_or_mismatched_manifest_id() {
        let bytes = fixture_zip(r#"{"id":"other-plugin"}"#);
        let error = verify_plugin_archive(PluginArtifactVerificationRequest {
            expected_sha256: sha256_hex(&bytes),
            bytes,
            requested_plugin_id: "smart-montage".to_string(),
            source_type: "uniopc_official_distributed".to_string(),
        })
        .expect_err("wrong manifest id must fail");

        assert_eq!(error.code, "plugin_artifact_invalid");
        assert!(error.message.contains("manifest id"));
    }

    #[test]
    fn artifact_rejects_missing_malformed_and_future_plugin_api_requirements() {
        let cases = [
            ("missing", None),
            (
                "malformed",
                Some(r#"{"openclaw":{"compat":{"pluginApi":"tomorrow"}}}"#),
            ),
            (
                "future",
                Some(r#"{"openclaw":{"compat":{"pluginApi":">=2027.1.0"}}}"#),
            ),
        ];

        for (case, package_json) in cases {
            let bytes = fixture_zip_with_package(r#"{"id":"smart-montage"}"#, package_json);
            let error = verify_plugin_archive(PluginArtifactVerificationRequest {
                expected_sha256: sha256_hex(&bytes),
                bytes,
                requested_plugin_id: "smart-montage".to_string(),
                source_type: "uniopc_official_distributed".to_string(),
            })
            .expect_err(case);

            assert_eq!(
                error.code, "plugin_api_incompatible",
                "{case} requirement must fail closed: {error}"
            );
        }
    }

    #[test]
    fn artifact_matches_the_locked_2026_8_1_comparator_grammar() {
        for (requirement, normalized) in [
            ("=2026.8.1", "=2026.8.1"),
            ("2026.8.1", "=2026.8.1"),
            ("^2026.8.1", "^2026.8.1"),
            ("~2026.8.0", "~2026.8.0"),
            (">=2026.8.1", ">=2026.8.1"),
            (">=2026.8.0 <2026.9.0", ">=2026.8.0, <2026.9.0"),
        ] {
            let package_json =
                format!(r#"{{"openclaw":{{"compat":{{"pluginApi":"{requirement}"}}}}}}"#);
            let bytes = fixture_zip_with_package(r#"{"id":"smart-montage"}"#, Some(&package_json));
            let artifact = verify_plugin_archive(PluginArtifactVerificationRequest {
                expected_sha256: sha256_hex(&bytes),
                bytes,
                requested_plugin_id: "smart-montage".to_string(),
                source_type: "uniopc_official_distributed".to_string(),
            })
            .unwrap_or_else(|error| panic!("{requirement} must match the host: {error}"));

            assert_eq!(
                artifact.plugin_api_compatibility.requirement.to_string(),
                normalized
            );
            assert_eq!(
                artifact.plugin_api_compatibility.host.to_string(),
                "2026.8.1"
            );
            artifact.cleanup().expect("stage cleanup");
        }

        for requirement in [
            ">=2026.8.0, <2026.9.0",
            ">=2026.8.0 || <2026.9.0",
            ">= 2026.8.0",
        ] {
            let package_json =
                format!(r#"{{"openclaw":{{"compat":{{"pluginApi":"{requirement}"}}}}}}"#);
            let bytes = fixture_zip_with_package(r#"{"id":"smart-montage"}"#, Some(&package_json));
            let error = verify_plugin_archive(PluginArtifactVerificationRequest {
                expected_sha256: sha256_hex(&bytes),
                bytes,
                requested_plugin_id: "smart-montage".to_string(),
                source_type: "uniopc_official_distributed".to_string(),
            })
            .expect_err(requirement);

            assert_eq!(error.code, "plugin_api_incompatible");
            assert_eq!(error.plugin_api_requirement, None);
        }
    }
}
