//! Private FFmpeg runtime for the Smart Montage plugin.
//!
//! This is deliberately separate from the user's PATH, Homebrew, or any
//! system package manager. Plugin install downloads the exact, checksummed
//! pair for this machine into `<app data>/Uniopc/media-runtime/` and flips a
//! small `current` pointer only after both tools have been verified.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::services::uniopc_runtime_paths as runtime_paths;

const VERSION: &str = "b6.1.1";
const RELEASE_BASE: &str = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";
static INSTALL_LOCK: Mutex<()> = Mutex::new(());
static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
struct Artifact {
    file_name: &'static str,
    sha256: &'static str,
}

fn platform_arch() -> Result<(&'static str, &'static str), String> {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err("当前系统不支持智能混剪媒体运行时。".to_string());
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        return Err("当前 CPU 架构不支持智能混剪媒体运行时。".to_string());
    };
    if platform != "darwin" && arch != "x64" {
        return Err("当前系统缺少可用的智能混剪媒体运行时制品。".to_string());
    }
    Ok((platform, arch))
}

fn artifacts() -> Result<(Artifact, Artifact), String> {
    let (platform, arch) = platform_arch()?;
    let (ffmpeg, ffprobe) = match (platform, arch) {
        ("darwin", "arm64") => (
            Artifact { file_name: "ffmpeg-darwin-arm64", sha256: "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584" },
            Artifact { file_name: "ffprobe-darwin-arm64", sha256: "bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64" },
        ),
        ("darwin", "x64") => (
            Artifact { file_name: "ffmpeg-darwin-x64", sha256: "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894" },
            Artifact { file_name: "ffprobe-darwin-x64", sha256: "fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0" },
        ),
        ("linux", "x64") => (
            Artifact { file_name: "ffmpeg-linux-x64", sha256: "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99" },
            Artifact { file_name: "ffprobe-linux-x64", sha256: "4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d" },
        ),
        ("win32", "x64") => (
            Artifact { file_name: "ffmpeg-win32-x64", sha256: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00" },
            Artifact { file_name: "ffprobe-win32-x64", sha256: "3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4" },
        ),
        _ => return Err("当前系统缺少可用的智能混剪媒体运行时制品。".to_string()),
    };
    Ok((ffmpeg, ffprobe))
}

fn tool_name(base: &str) -> String {
    if cfg!(windows) { format!("{base}.exe") } else { base.to_string() }
}

fn install_id() -> Result<String, String> {
    let (platform, arch) = platform_arch()?;
    Ok(format!("{VERSION}-{platform}-{arch}"))
}

fn usable(directory: &Path) -> bool {
    directory.join(tool_name("ffmpeg")).is_file() && directory.join(tool_name("ffprobe")).is_file()
}

/// Blocking, idempotent installation. Call from `spawn_blocking` when invoked
/// from a Tauri command.
pub fn ensure_installed() -> Result<(), String> {
    let _lock = INSTALL_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if usable(&runtime_paths::media_runtime_current_dir()?) {
        return Ok(());
    }
    let base = runtime_paths::uniopc_data_dir()?.join("media-runtime");
    fs::create_dir_all(&base).map_err(|error| format!("创建智能混剪媒体运行时目录失败: {error}"))?;
    let final_dir = base.join(install_id()?);
    if !usable(&final_dir) {
        let staging = base.join(format!(".staging-{}-{}", std::process::id(), STAGING_SEQ.fetch_add(1, Ordering::Relaxed)));
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging).map_err(|error| format!("创建媒体运行时暂存目录失败: {error}"))?;
        let outcome = install_into(&staging);
        if let Err(error) = outcome {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let _ = fs::remove_dir_all(&final_dir);
        fs::rename(&staging, &final_dir).map_err(|error| format!("落位智能混剪媒体运行时失败: {error}"))?;
    }
    activate(&base, &final_dir)
}

fn install_into(staging: &Path) -> Result<(), String> {
    let (ffmpeg, ffprobe) = artifacts()?;
    download_verified(&ffmpeg, &staging.join(tool_name("ffmpeg")))?;
    download_verified(&ffprobe, &staging.join(tool_name("ffprobe")))?;
    if !usable(staging) {
        return Err("智能混剪媒体运行时下载后缺少 FFmpeg 或 FFprobe。".to_string());
    }
    Ok(())
}

fn download_verified(artifact: &Artifact, target: &Path) -> Result<(), String> {
    let url = format!("{RELEASE_BASE}/{}", artifact.file_name);
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(900))
        .no_proxy()
        .build()
        .map_err(|error| format!("创建媒体运行时下载客户端失败: {error}"))?;
    let mut response = client.get(&url).send().map_err(|error| format!("下载智能混剪媒体运行时失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载智能混剪媒体运行时失败: HTTP {}", response.status()));
    }
    let temporary = target.with_extension("download");
    let mut file = fs::File::create(&temporary).map_err(|error| format!("写入媒体运行时失败: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = response.read(&mut buffer).map_err(|error| format!("读取媒体运行时下载内容失败: {error}"))?;
        if count == 0 { break; }
        use std::io::Write;
        file.write_all(&buffer[..count]).map_err(|error| format!("写入媒体运行时失败: {error}"))?;
        digest.update(&buffer[..count]);
    }
    let actual = hex::encode(digest.finalize());
    if actual != artifact.sha256 {
        let _ = fs::remove_file(&temporary);
        return Err("智能混剪媒体运行时完整性校验失败。".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("设置媒体运行时权限失败: {error}"))?;
    }
    fs::rename(&temporary, target).map_err(|error| format!("完成媒体运行时下载失败: {error}"))
}

fn activate(base: &Path, final_dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let temporary = base.join(format!(".current-{}", std::process::id()));
        let _ = fs::remove_file(&temporary);
        symlink(final_dir, &temporary).map_err(|error| format!("创建媒体运行时指针失败: {error}"))?;
        fs::rename(&temporary, base.join("current")).map_err(|error| format!("激活智能混剪媒体运行时失败: {error}"))?;
    }
    #[cfg(windows)]
    {
        let temporary = base.join(format!(".current-{}", std::process::id()));
        fs::write(&temporary, final_dir.file_name().unwrap_or_default().to_string_lossy().as_bytes())
            .map_err(|error| format!("写入媒体运行时版本指针失败: {error}"))?;
        fs::rename(&temporary, base.join("current.version")).map_err(|error| format!("激活智能混剪媒体运行时失败: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_artifacts_have_sha256_digests() {
        let (ffmpeg, ffprobe) = artifacts().unwrap();
        for artifact in [ffmpeg, ffprobe] {
            assert_eq!(artifact.sha256.len(), 64);
            assert!(artifact.sha256.chars().all(|character| character.is_ascii_hexdigit()));
            assert!(artifact.file_name.starts_with("ff"));
        }
    }
}
