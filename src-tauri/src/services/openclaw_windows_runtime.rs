//! Windows engine-runtime provisioning (Phase 1 of Windows sidecar support).
//!
//! macOS/Linux ship a prefix-relocatable runtime archive that
//! `openclaw_bundled_runtime` extracts on first launch. Windows has no such
//! bundle yet, and the pure-sidecar (`GatewaySupervisor`) deliberately refuses
//! to spawn a *system* `openclaw` — so on Windows the app can never start the
//! gateway.
//!
//! This module closes that gap by provisioning a private, app-owned runtime the
//! same way the Unix network-installer fallback does: it downloads a portable
//! Node.js, `npm install`s the pinned `openclaw` into
//! `<app data>/Uniopc/runtime/v<version>/tools/node/`, then hands off to
//! `openclaw_bundled_runtime::activate_runtime_version` to flip `current`.
//!
//! The resulting layout is the natural Windows npm prefix layout
//! (`tools/node/node.exe`, `tools/node/uniopc-engine.cmd`,
//! `tools/node/node_modules/uniopc-engine/`), which the Windows branches of
//! `spawnable_command`, `runtime_shim_path` and `installed_openclaw_version`
//! know how to resolve. Nothing here reads or touches a developer's own
//! `~/.openclaw` / global npm install.

#![cfg(target_os = "windows")]

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::Command;

use crate::services::openclaw_bundled_runtime;
use crate::services::openclaw_runtime_catalog::OPENCLAW_RELEASE_NODE_VERSION;
use crate::services::uniopc_runtime_paths as runtime_paths;

/// Portable Node.js pinned to the exact embedded release contract. Keep this
/// in lockstep with `openclaw_runtime_catalog::OPENCLAW_RELEASE_NODE_VERSION`.
const NODE_DIST_ARCH: &str = "win-x64";

fn node_archive_stem() -> String {
    format!("node-v{OPENCLAW_RELEASE_NODE_VERSION}-{NODE_DIST_ARCH}")
}

fn node_archive_url() -> String {
    format!(
        "https://nodejs.org/dist/v{OPENCLAW_RELEASE_NODE_VERSION}/{}.zip",
        node_archive_stem()
    )
}

/// True when `runtime/current` already resolves to a valid install of the
/// requested version — provisioning is then a no-op.
pub fn already_provisioned(version: &str) -> bool {
    openclaw_bundled_runtime::active_runtime_matches(version)
}

/// Provision (download + install) the private Windows runtime for `requested`
/// and activate it. `requested` may be a concrete version or `"latest"`; the
/// returned string is the concrete engine version actually installed.
///
/// Blocking (network download + npm). Callers run it on a blocking thread.
pub fn provision(
    requested: &str,
    mut on_progress: impl FnMut(&str, f64),
) -> Result<String, String> {
    let base = runtime_paths::runtime_base_dir()?;
    fs::create_dir_all(&base).map_err(|e| format!("创建运行时目录失败: {e}"))?;

    let staging = base.join(format!(".win-provision-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| format!("创建运行时暂存目录失败: {e}"))?;

    let result = provision_into_staging(&staging, requested, &mut on_progress);
    match result {
        Ok(version) => {
            on_progress("落位运行时版本目录", 92.0);
            let version_dir = runtime_paths::runtime_version_dir(&version)?;
            let _ = fs::remove_dir_all(&version_dir);
            if let Some(parent) = version_dir.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建运行时目录失败: {e}"))?;
            }
            fs::rename(&staging, &version_dir)
                .map_err(|e| format!("落位运行时版本目录失败: {e}"))?;
            on_progress("激活运行时", 96.0);
            openclaw_bundled_runtime::activate_runtime_version(&version)?;
            Ok(version)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

fn provision_into_staging(
    staging: &Path,
    requested: &str,
    on_progress: &mut impl FnMut(&str, f64),
) -> Result<String, String> {
    let node_dir = staging.join("tools").join("node");
    fs::create_dir_all(&node_dir).map_err(|e| format!("创建 Node 目录失败: {e}"))?;

    on_progress("下载 Node.js 运行时", 15.0);
    let zip_bytes = download_bytes(&node_archive_url())?;

    on_progress("解压 Node.js 运行时", 45.0);
    extract_node_zip(&zip_bytes, &node_dir)?;

    let node_exe = node_dir.join("node.exe");
    if !node_exe.is_file() {
        return Err("Node.js 解压后缺少 node.exe。".to_string());
    }

    on_progress("安装 Uniopc 引擎", 60.0);
    npm_install_openclaw(&node_dir, requested)?;
    rename_installed_engine(&node_dir)?;

    let version = openclaw_bundled_runtime::installed_openclaw_version(staging)
        .ok_or_else(|| "安装后未能读取 Uniopc 引擎 版本。".to_string())?;

    on_progress("生成引擎启动器", 88.0);
    write_openclaw_cmd_shim(&node_dir)?;

    Ok(version)
}

fn rename_installed_engine(node_dir: &Path) -> Result<(), String> {
    let modules = node_dir.join("node_modules");
    let source = modules.join("openclaw");
    let target = modules.join("uniopc-engine");
    fs::rename(&source, &target).map_err(|e| format!("重命名引擎目录失败: {e}"))?;
    let entry = target.join("openclaw.mjs");
    fs::rename(&entry, target.join("uniopc-engine.mjs"))
        .map_err(|e| format!("重命名引擎入口失败: {e}"))?;

    // Keep npm's upstream package name because plugin SDK consumers resolve
    // `openclaw/plugin-sdk`; the installed directory and executable are branded.
    let manifest_path = target.join("package.json");
    let raw = fs::read_to_string(&manifest_path).map_err(|e| format!("读取引擎清单失败: {e}"))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("解析引擎清单失败: {e}"))?;
    if let Some(bin) = manifest
        .get_mut("bin")
        .and_then(serde_json::Value::as_object_mut)
    {
        let old = bin.remove("openclaw");
        if let Some(value) = old {
            bin.insert("uniopc-engine".to_string(), value);
        }
        for value in bin.values_mut() {
            if value.as_str() == Some("openclaw.mjs") {
                *value = serde_json::Value::String("uniopc-engine.mjs".to_string());
            }
        }
    }
    if manifest
        .pointer("/exports/./cli-entry")
        .and_then(serde_json::Value::as_str)
        == Some("./openclaw.mjs")
    {
        manifest["exports"]["./cli-entry"] =
            serde_json::Value::String("./uniopc-engine.mjs".to_string());
    }
    if manifest
        .pointer("/scripts/start")
        .and_then(serde_json::Value::as_str)
        == Some("node openclaw.mjs")
    {
        manifest["scripts"]["start"] =
            serde_json::Value::String("node uniopc-engine.mjs".to_string());
    }
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("序列化引擎清单失败: {e}"))?,
    )
    .map_err(|e| format!("写入引擎清单失败: {e}"))?;
    Ok(())
}

fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建下载客户端失败: {e}"))?;
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("下载 Node.js 失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "下载 Node.js 失败: HTTP {} ({url})",
            response.status()
        ));
    }
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|e| format!("读取 Node.js 下载内容失败: {e}"))
}

/// Extract `node-<ver>-win-x64.zip` into `node_dir`, stripping the single
/// top-level `node-<ver>-win-x64/` directory the archive wraps everything in.
fn extract_node_zip(zip_bytes: &[u8], node_dir: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(zip_bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("打开 Node.js 压缩包失败: {e}"))?;
    let top_prefix = format!("{}/", node_archive_stem());

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("读取 Node.js 压缩包条目失败: {e}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let relative = enclosed
            .strip_prefix(&top_prefix)
            .ok()
            .map(Path::to_path_buf)
            .unwrap_or(enclosed);
        if relative.as_os_str().is_empty() {
            continue;
        }
        let out_path = node_dir.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("创建 Node.js 目录失败: {e}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建 Node.js 目录失败: {e}"))?;
        }
        let mut out_file =
            fs::File::create(&out_path).map_err(|e| format!("写入 Node.js 文件失败: {e}"))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("写入 Node.js 文件失败: {e}"))?;
    }
    Ok(())
}

/// `npm install --global --prefix <node_dir> openclaw@<requested>` using the
/// just-extracted Node so the engine lands at
/// `<node_dir>/node_modules/uniopc-engine` with an `<node_dir>/uniopc-engine.cmd` shim.
fn npm_install_openclaw(node_dir: &Path, requested: &str) -> Result<(), String> {
    let npm_cli = node_dir
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    if !npm_cli.is_file() {
        return Err("Node.js 运行时缺少 npm。".to_string());
    }
    let node_exe = node_dir.join("node.exe");
    let spec = format!("openclaw@{requested}");

    let mut command = Command::new(&node_exe);
    command
        .arg(&npm_cli)
        .arg("install")
        .arg("--global")
        .arg("--prefix")
        .arg(node_dir)
        .arg("--no-audit")
        .arg("--no-fund")
        .arg("--loglevel=error")
        .arg(&spec)
        // Keep the install self-contained: never read a developer's user-level
        // npm config, and never mutate the shared npm cache.
        .env("NPM_CONFIG_USERCONFIG", node_dir.join(".npmrc-uniopc"))
        .env("NPM_CONFIG_CACHE", node_dir.join(".npm-cache"))
        .env("NPM_CONFIG_UPDATE_NOTIFIER", "false")
        .env("NO_UPDATE_NOTIFIER", "1")
        .env("PATH", augmented_node_path(node_dir))
        .current_dir(node_dir);
    for (key, value) in crate::services::openclaw_cli::local_loopback_env_overrides() {
        command.env(key, value);
    }
    crate::services::openclaw_cli::hide_console(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("执行 npm 安装 Uniopc 引擎 失败: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "npm 安装 Uniopc 引擎 失败: {}",
            tail(&[stderr.as_ref(), stdout.as_ref()].join("\n"), 20)
        ));
    }
    Ok(())
}

/// `bin/openclaw.cmd`-equivalent launcher next to the engine so both
/// `runtime_shim_path` (validation) and the `cmd /C` fallback in
/// `spawnable_command` have a working entrypoint. The primary spawn path uses
/// `node.exe uniopc-engine.mjs` directly; this is the belt-and-suspenders shim.
fn write_openclaw_cmd_shim(node_dir: &Path) -> Result<(), String> {
    let shim = node_dir.join("uniopc-engine.cmd");
    let legacy_shim = node_dir.join("openclaw.cmd");
    let legacy_package_shims = node_dir.join("node_modules").join(".bin");
    // npm usually writes this already; only author ours when it is missing so we
    // never clobber the package-manager-generated shim.
    if shim.is_file() {
        if legacy_shim.exists() {
            let _ = fs::remove_file(legacy_shim);
        }
        for name in ["openclaw", "openclaw.cmd", "openclaw.ps1"] {
            let _ = fs::remove_file(legacy_package_shims.join(name));
        }
        return Ok(());
    }
    let body = "@echo off\r\n\"%~dp0node.exe\" \"%~dp0node_modules\\uniopc-engine\\uniopc-engine.mjs\" %*\r\n";
    let mut file = fs::File::create(&shim).map_err(|e| format!("写入引擎启动器失败: {e}"))?;
    file.write_all(body.as_bytes())
        .map_err(|e| format!("写入引擎启动器失败: {e}"))?;
    let _ = fs::remove_file(legacy_shim);
    for name in ["openclaw", "openclaw.cmd", "openclaw.ps1"] {
        let _ = fs::remove_file(legacy_package_shims.join(name));
    }
    Ok(())
}

fn augmented_node_path(node_dir: &Path) -> std::ffi::OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs = vec![node_dir.to_path_buf()];
    dirs.extend(std::env::split_paths(&existing));
    std::env::join_paths(dirs).unwrap_or(existing)
}

fn tail(text: &str, lines: usize) -> String {
    let collected: Vec<&str> = text.lines().collect();
    let start = collected.len().saturating_sub(lines);
    collected[start..].join("\n")
}
