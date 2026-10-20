use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Runtime};

use crate::services::openclaw_gateway::DEFAULT_OPERATOR_CONNECT_SCOPES;

/// Restrict a directory that holds the device identity / cached tokens to the
/// owner only (0700). Best-effort: a failure to tighten perms must not block the
/// auth flow, but on macOS every local account is in `staff` and can traverse
/// `$HOME`, so a world-readable identity dir leaks the ed25519 signing key.
#[cfg(unix)]
pub(crate) fn harden_dir_permissions(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
pub(crate) fn harden_dir_permissions(_dir: &Path) {}

/// Best-effort tighten of an existing secret file to 0600. Migrates identity /
/// token files written 0644 by an older build without forcing a rewrite.
#[cfg(unix)]
pub(crate) fn harden_existing_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
pub(crate) fn harden_existing_file(_path: &Path) {}

/// Write a secret file with owner-only permissions (0600). The private ed25519
/// key and the scoped device token must never be world-readable — plain
/// `fs::write` inherits the process umask (0644 in practice), which the sibling
/// OpenClaw Node runtime avoids by writing its own identity files at 0600.
pub(crate) fn write_secret_file(path: &Path, contents: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents.as_bytes())?;
        // `mode()` only applies on creation; force 0600 for a pre-existing file
        // that may have been written 0644 by an older build.
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, contents)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredDeviceIdentity {
    device_id: String,
    public_key_hex: String,
    secret_key_hex: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredGatewayDeviceToken {
    pub device_id: String,
    pub device_token: String,
    pub role: Option<String>,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct DeviceIdentityInfo {
    pub device_id: String,
    pub public_key_hex: String,
    pub secret_key_hex: String,
}

pub fn operator_connect_scopes() -> Vec<String> {
    DEFAULT_OPERATOR_CONNECT_SCOPES
        .iter()
        .map(|scope| (*scope).to_string())
        .collect()
}

pub fn cached_device_token_covers_official_operator_scopes(
    token: &StoredGatewayDeviceToken,
) -> bool {
    let granted = token
        .scopes
        .iter()
        .map(|scope| scope.trim())
        .collect::<std::collections::HashSet<_>>();
    DEFAULT_OPERATOR_CONNECT_SCOPES
        .iter()
        .all(|scope| granted.contains(scope))
}

pub fn base64_url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn device_identity_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?
        .join("conversations");
    fs::create_dir_all(&dir).map_err(|e| format!("创建对话身份目录失败: {e}"))?;
    harden_dir_permissions(&dir);
    Ok(dir.join("device-identity.json"))
}

fn gateway_device_token_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?
        .join("conversations");
    fs::create_dir_all(&dir).map_err(|e| format!("创建对话鉴权目录失败: {e}"))?;
    harden_dir_permissions(&dir);
    Ok(dir.join("gateway-device-token.json"))
}

fn create_device_identity() -> StoredDeviceIdentity {
    let secret_key_bytes: [u8; 32] = rand::random();
    let signing_key = SigningKey::from_bytes(&secret_key_bytes);
    let public_key_bytes = signing_key.verifying_key().to_bytes();
    let device_id = hex::encode(Sha256::digest(public_key_bytes));

    StoredDeviceIdentity {
        device_id,
        public_key_hex: hex::encode(public_key_bytes),
        secret_key_hex: hex::encode(secret_key_bytes),
        created_at: chrono::Utc::now().to_rfc3339(),
    }
}

pub fn ensure_device_identity<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<DeviceIdentityInfo, String> {
    let path = device_identity_path(app)?;
    let stored = if path.exists() {
        harden_existing_file(&path);
        let raw =
            fs::read_to_string(&path).map_err(|e| format!("读取本地 device identity 失败: {e}"))?;
        serde_json::from_str::<StoredDeviceIdentity>(&raw)
            .map_err(|e| format!("解析本地 device identity 失败: {e}"))?
    } else {
        let created = create_device_identity();
        let serialized = serde_json::to_string_pretty(&created)
            .map_err(|e| format!("序列化本地 device identity 失败: {e}"))?;
        write_secret_file(&path, &format!("{serialized}\n"))
            .map_err(|e| format!("写入本地 device identity 失败: {e}"))?;
        created
    };

    Ok(DeviceIdentityInfo {
        device_id: stored.device_id,
        public_key_hex: stored.public_key_hex,
        secret_key_hex: stored.secret_key_hex,
    })
}

pub fn device_public_key_base64_url(
    device_identity: &DeviceIdentityInfo,
) -> Result<String, String> {
    let public_key_bytes = hex::decode(&device_identity.public_key_hex)
        .map_err(|e| format!("解析本地 device public key 失败: {e}"))?;
    Ok(base64_url_encode(&public_key_bytes))
}

pub fn read_cached_device_token<R: Runtime>(
    app: &AppHandle<R>,
    expected_device_id: &str,
) -> Result<Option<StoredGatewayDeviceToken>, String> {
    let path = gateway_device_token_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    harden_existing_file(&path);

    let raw = fs::read_to_string(&path).map_err(|e| format!("读取缓存 device token 失败: {e}"))?;
    let stored = serde_json::from_str::<StoredGatewayDeviceToken>(&raw)
        .map_err(|e| format!("解析缓存 device token 失败: {e}"))?;

    if stored.device_id != expected_device_id || stored.device_token.trim().is_empty() {
        return Ok(None);
    }

    Ok(Some(stored))
}

pub fn persist_cached_device_token<R: Runtime>(
    app: &AppHandle<R>,
    device_id: &str,
    device_token: &str,
    role: Option<String>,
    scopes: Vec<String>,
) -> Result<(), String> {
    let path = gateway_device_token_path(app)?;
    let now = chrono::Utc::now().to_rfc3339();
    let created_at = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<StoredGatewayDeviceToken>(&raw).ok())
            .map(|stored| stored.created_at)
            .unwrap_or_else(|| now.clone())
    } else {
        now.clone()
    };

    let stored = StoredGatewayDeviceToken {
        device_id: device_id.to_string(),
        device_token: device_token.to_string(),
        role,
        scopes,
        created_at,
        updated_at: now,
    };
    let serialized = serde_json::to_string_pretty(&stored)
        .map_err(|e| format!("序列化缓存 device token 失败: {e}"))?;
    write_secret_file(&path, &format!("{serialized}\n"))
        .map_err(|e| format!("写入缓存 device token 失败: {e}"))
}

pub fn build_openclaw_device_auth_payload_v3(
    device_id: &str,
    client_id: &str,
    client_mode: &str,
    role: &str,
    scopes: &[String],
    signed_at: i64,
    auth_token: Option<&str>,
    nonce: &str,
    platform: &str,
    device_family: Option<&str>,
) -> String {
    format!(
        "v3|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        device_id,
        client_id,
        client_mode,
        role,
        scopes.join(","),
        signed_at,
        auth_token.unwrap_or_default(),
        nonce,
        platform,
        device_family.unwrap_or_default(),
    )
}

pub fn signed_device_connect_params(
    identity: &DeviceIdentityInfo,
    client_id: &str,
    client_mode: &str,
    role: &str,
    scopes: &[String],
    signed_at: i64,
    auth_token: Option<&str>,
    nonce: &str,
    platform: &str,
    device_family: &str,
) -> Result<Value, String> {
    let public_key = device_public_key_base64_url(identity)?;
    let signing_key_bytes_vec = hex::decode(&identity.secret_key_hex)
        .map_err(|e| format!("解析本地 device secret 失败: {e}"))?;
    let signing_key_bytes: [u8; 32] = signing_key_bytes_vec
        .try_into()
        .map_err(|_| "本地 device secret 长度无效。".to_string())?;
    let signing_key = SigningKey::from_bytes(&signing_key_bytes);
    let signature_payload = build_openclaw_device_auth_payload_v3(
        &identity.device_id,
        client_id,
        client_mode,
        role,
        scopes,
        signed_at,
        auth_token,
        nonce,
        platform,
        Some(device_family),
    );
    let signature = signing_key.sign(signature_payload.as_bytes());
    Ok(json!({
        "id": identity.device_id,
        "publicKey": public_key,
        "signature": base64_url_encode(&signature.to_bytes()),
        "signedAt": signed_at,
        "nonce": nonce,
    }))
}
