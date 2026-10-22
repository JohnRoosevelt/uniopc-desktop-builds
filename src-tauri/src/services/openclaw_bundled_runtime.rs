//! Bundled engine runtime: first-launch offline install into Uniopc's
//! private, versioned runtime directory.
//!
//! The release build packs a prefix-relocatable runtime archive
//! (`uniopc-engine-runtime-<platform>-<arch>.tar.gz`, produced by
//! `scripts/build-openclaw-runtime-bundle.mjs`) into the app resources under
//! `uniopc-engine-runtime/`. On first launch we extract it into
//! `<app data>/Uniopc/runtime/v<version>/` and point `runtime/current` at it
//! (see `uniopc_runtime_paths`). Upgrades extract a new version dir and flip
//! the pointer; rollback is flipping it back. The layout is private to
//! Uniopc — a developer's own `~/.openclaw` install is neither read nor
//! touched.
//!
//! The build-generated catalog includes a digest and expected size for every
//! platform/architecture artifact. Those values are re-verified before any
//! archive is extracted, even when the outer app bundle is code-signed.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::services::openclaw_engine_contract::OPENCLAW_ENGINE_VERSION;
use crate::services::openclaw_runtime_catalog::{
    node_version_is_supported, select_runtime_artifact, verify_archive_bytes, RuntimeArtifact,
    RuntimeCatalog,
};
use crate::services::uniopc_runtime_paths as runtime_paths;

pub const RUNTIME_RESOURCE_DIR: &str = "uniopc-engine-runtime";
const RUNTIME_CATALOG_FILE: &str = "uniopc-engine-runtime.catalog.json";
const RUNTIME_SUBTREES: &[&str] = &["bin", "tools"];
const INSTALLING_MARKER: &str = ".uniopc-installing";
const CLEANUP_WARNING_FILE: &str = "runtime-cleanup-warning.txt";

// Serialize runtime activation within the process. The startup hook and the
// frontend install command both call ensure_bundled_runtime_installed; without
// this they race into the same staging dir and clobber each other (one sees a
// half-deleted "missing bin/", the other hits os error 32 on the version-dir
// rename). The loser now just waits and observes AlreadyExtracted.
static ACTIVATION_LOCK: Mutex<Option<VerifiedArchive>> = Mutex::new(None);
// Serialize pointer flips against post-health cleanup so an engine update cannot
// activate a new version between the health check and removal of the old one.
static RUNTIME_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());
// Monotonic suffix so each extraction stages into its own dir even if two ever
// run without the lock (belt-and-suspenders alongside ACTIVATION_LOCK).
static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// A release must never activate an embedded runtime older or newer than the
/// engine version compiled into the app. Runtime artifacts are deliberately
/// ignored by git and rebuilt per platform, so this guard prevents a stale
/// local/CI artifact from downgrading an otherwise valid private runtime.
fn bundled_artifact_matches_declared_version(version: &str) -> bool {
    version == OPENCLAW_ENGINE_VERSION
}

#[derive(Debug, Clone)]
pub enum BundledRuntimeOutcome {
    /// The bundled version dir is already active.
    AlreadyExtracted { version: String },
    /// The bundled runtime was extracted (or re-activated) and `current` now
    /// points at it.
    Extracted { version: String },
    /// No usable bundle for this machine (dev build, arch mismatch, missing or
    /// invalid artifact). Callers must surface the diagnostic rather than use
    /// a network installer.
    Unavailable { reason: String },
}

/// A runtime install is immutable for a specific verified artifact, not only
/// for an OpenClaw package version. This lets us ship a repaired bundle built
/// from the same upstream version without overwriting the runtime that is
/// currently executing.
fn artifact_runtime_id(artifact: &RuntimeArtifact) -> Result<String, String> {
    let digest = artifact.sha256.trim().to_ascii_lowercase();
    if digest.len() < 12
        || !digest
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("内置运行时清单的 SHA-256 格式无效。".to_string());
    }
    Ok(format!("{}-{}", artifact.version, &digest[..12]))
}

/// Node's `process.platform` / `process.arch` names, to match the manifest
/// written by the bundle build script.
fn node_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn node_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        "unknown"
    }
}

fn bundled_runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(RUNTIME_RESOURCE_DIR);
        if bundled.join(RUNTIME_CATALOG_FILE).exists() {
            return Some(bundled);
        }
    }
    // Dev builds read straight from the repo (populated by
    // `npm run build:openclaw-runtime`).
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(RUNTIME_RESOURCE_DIR);
    if dev_dir.join(RUNTIME_CATALOG_FILE).exists() {
        return Some(dev_dir);
    }
    None
}

/// The verified bundled runtime artifact + archive path, when one exists that
/// matches this machine's platform/arch.
pub fn bundled_runtime_archive(app: &AppHandle) -> Result<(RuntimeArtifact, PathBuf), String> {
    let mut verified_archive = ACTIVATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (artifact, archive) = select_bundled_runtime_archive(app)?;
    verify_archive_cached(&artifact, &archive, &mut verified_archive)?;
    Ok((artifact, archive))
}

fn select_bundled_runtime_archive(app: &AppHandle) -> Result<(RuntimeArtifact, PathBuf), String> {
    let dir = bundled_runtime_dir(app)
        .ok_or_else(|| "安装包内未携带 Uniopc 引擎运行时制品。".to_string())?;
    let catalog_raw = fs::read_to_string(dir.join(RUNTIME_CATALOG_FILE))
        .map_err(|e| format!("读取内置运行时清单失败: {e}"))?;
    let catalog: RuntimeCatalog =
        serde_json::from_str(&catalog_raw).map_err(|e| format!("解析内置运行时清单失败: {e}"))?;
    let artifact = select_runtime_artifact(&catalog, node_platform(), node_arch())?.clone();
    if !bundled_artifact_matches_declared_version(&artifact.version) {
        return Err(format!(
            "内置 Uniopc 引擎版本 {} 与应用声明的精确版本 {} 不一致。",
            artifact.version, OPENCLAW_ENGINE_VERSION
        ));
    }
    if !node_version_is_supported(&artifact.node_version) {
        return Err(format!(
            "内置 Node.js 版本 {} 不满足 Uniopc 引擎 8.1 运行时要求。",
            artifact.node_version
        ));
    }
    let archive = dir.join(&artifact.archive);
    if !archive.is_file() {
        return Err(format!(
            "内置运行时压缩包缺失: {}",
            archive.to_string_lossy()
        ));
    }
    Ok((artifact, archive))
}

fn verify_archive_file(artifact: &RuntimeArtifact, archive: &Path) -> Result<(), String> {
    let archive_bytes = fs::read(archive).map_err(|e| {
        format!(
            "读取内置运行时压缩包失败 {}: {e}",
            archive.to_string_lossy()
        )
    })?;
    verify_archive_bytes(artifact, &archive_bytes)
}

// Process-local only: each app launch verifies the archive at least once.
// Include every catalog field and filesystem identity/change metadata so an
// updated or replaced bundle cannot inherit another artifact's verification.
/// A cheap-to-recheck identity for an archive that has already passed its
/// digest verification. It is persisted so an unchanged release archive is
/// not re-hashed on the first engine start of every desktop process.
///
/// This is an optimization, never an authorization for extraction: extraction
/// always clears the cache and verifies the archive bytes again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct VerifiedArchive {
    artifact: serde_json::Value,
    path: PathBuf,
    len: u64,
    modified_nanos: u128,
    created_nanos: Option<u128>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

fn archive_fingerprint(
    artifact: &RuntimeArtifact,
    archive: &Path,
) -> Result<VerifiedArchive, String> {
    let metadata =
        fs::metadata(archive).map_err(|error| format!("读取运行时制品信息失败: {error}"))?;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(VerifiedArchive {
        artifact: serde_json::json!({
            "version": artifact.version, "platform": artifact.platform,
            "arch": artifact.arch, "archive": artifact.archive,
            "sha256": artifact.sha256, "sizeBytes": artifact.size_bytes,
            "nodeVersion": artifact.node_version,
        }),
        path: archive.to_path_buf(),
        len: metadata.len(),
        modified_nanos: metadata
            .modified()
            .map_err(|error| format!("读取运行时制品修改时间失败: {error}"))?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| format!("运行时制品修改时间早于 Unix epoch: {error}"))?
            .as_nanos(),
        created_nanos: metadata.created().ok().and_then(|time| {
            time.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|duration| duration.as_nanos())
        }),
        #[cfg(unix)]
        identity: (
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        ),
    })
}

fn verified_archive_stamp_path() -> Result<PathBuf, String> {
    Ok(runtime_paths::runtime_base_dir()?.join("verified-archive.json"))
}

fn load_verified_archive_stamp_at(path: &Path) -> Option<VerifiedArchive> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn store_verified_archive_stamp_at(
    path: &Path,
    fingerprint: &VerifiedArchive,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "运行时校验缓存路径无父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建运行时校验缓存目录失败: {error}"))?;
    let staged = parent.join(format!(".verified-archive-{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(fingerprint)
        .map_err(|error| format!("序列化运行时校验缓存失败: {error}"))?;
    fs::write(&staged, bytes).map_err(|error| format!("写入运行时校验缓存失败: {error}"))?;
    if let Err(initial_error) = fs::rename(&staged, path) {
        // Windows does not replace an existing destination. This cache is
        // expendable, so a brief remove-and-replace fallback is sufficient.
        let _ = fs::remove_file(path);
        fs::rename(&staged, path).map_err(|error| {
            format!("提交运行时校验缓存失败: {initial_error}; fallback: {error}")
        })?;
    }
    Ok(())
}

fn persisted_archive_is_verified(
    artifact: &RuntimeArtifact,
    archive: &Path,
    stamp_path: &Path,
) -> Result<bool, String> {
    let fingerprint = archive_fingerprint(artifact, archive)?;
    Ok(load_verified_archive_stamp_at(stamp_path).as_ref() == Some(&fingerprint))
}

/// Returns true when this call performed full verification. Extraction callers
/// still verify unconditionally immediately before extraction.
fn verify_archive_cached(
    artifact: &RuntimeArtifact,
    archive: &Path,
    cached: &mut Option<VerifiedArchive>,
) -> Result<bool, String> {
    let before = archive_fingerprint(artifact, archive)?;
    if cached.as_ref() == Some(&before) {
        return Ok(false);
    }
    *cached = None;
    verify_archive_file(artifact, archive)?;
    let after = archive_fingerprint(artifact, archive)?;
    if before != after {
        return Err("内置运行时制品在校验期间发生变化，请重试。".to_string());
    }
    *cached = Some(after);
    Ok(true)
}

/// The selected package and its bytes must come from the same resolver for
/// ordinary verification and observed-status fingerprints.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
struct InstalledPackage {
    path: PathBuf,
    version: String,
    bytes: Vec<u8>,
    file: fs::File,
}

fn open_runtime_file(path: &Path, attributes_only: bool) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
        if attributes_only {
            options.access_mode(FILE_READ_ATTRIBUTES);
        } else {
            options.read(true);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = attributes_only;
        options.read(true);
    }
    options.open(path)
}

fn installed_openclaw_package(runtime_dir: &Path) -> Option<InstalledPackage> {
    use std::io::Read;
    let tools_dir = runtime_dir.join("tools");
    let read_package = |path: &Path| -> Option<InstalledPackage> {
        let mut file = open_runtime_file(path, false).ok()?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        let version = json
            .get("version")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?
            .to_owned();
        Some(InstalledPackage {
            path: path.to_owned(),
            version,
            bytes,
            file,
        })
    };
    let module_suffixes: [&[&str]; 2] = [
        &["lib", "node_modules", "uniopc-engine", "package.json"],
        &["node_modules", "uniopc-engine", "package.json"],
    ];
    let alias_root = tools_dir.join("node");
    for suffix in module_suffixes {
        if let Some(package) = read_package(&join_all(&alias_root, suffix)) {
            return Some(package);
        }
    }
    for entry in fs::read_dir(tools_dir).ok()?.filter_map(Result::ok) {
        for suffix in module_suffixes {
            if let Some(package) = read_package(&join_all(&entry.path(), suffix)) {
                return Some(package);
            }
        }
    }
    None
}

/// Version of the openclaw npm package installed under a runtime dir, if any.
pub fn installed_openclaw_version(runtime_dir: &Path) -> Option<String> {
    installed_openclaw_package(runtime_dir).map(|package| package.version)
}

fn join_all(base: &Path, parts: &[&str]) -> PathBuf {
    let mut path = base.to_path_buf();
    for part in parts {
        path = path.join(part);
    }
    path
}

fn runtime_shim_path(runtime_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        // Natural Windows npm-prefix layout: the engine shim sits at the node
        // prefix root next to node.exe, not under bin/ (which only the Unix
        // install-cli.sh bundle produces).
        runtime_dir
            .join("tools")
            .join("node")
            .join("uniopc-engine.cmd")
    } else {
        runtime_dir.join("bin").join("uniopc-engine")
    }
}

fn runtime_node_path(runtime_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        runtime_dir.join("tools").join("node").join("node.exe")
    } else {
        runtime_dir
            .join("tools")
            .join("node")
            .join("bin")
            .join("node")
    }
}

fn installed_node_version(runtime_dir: &Path) -> Option<String> {
    let mut command = Command::new(runtime_node_path(runtime_dir));
    // `node.exe --version` is also a console-subsystem program. Runtime
    // validation happens during desktop startup, so hide this brief probe just
    // like every other Windows OpenClaw/Node child.
    crate::services::openclaw_cli::hide_console(&mut command);
    let output = command.arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// A runtime directory is usable when its shim exists and its package version
/// matches the expected engine version. Its directory name may include an
/// artifact digest, so it is deliberately not used as the package version.
fn runtime_dir_is_valid(runtime_id: &str, expected_engine_version: &str) -> bool {
    let Ok(dir) = runtime_paths::runtime_version_dir(runtime_id) else {
        return false;
    };
    runtime_dir_is_valid_at(&dir, expected_engine_version)
}

fn runtime_dir_is_valid_at(dir: &Path, expected_engine_version: &str) -> bool {
    !dir.join(INSTALLING_MARKER).exists()
        && runtime_shim_path(dir).exists()
        && installed_openclaw_version(dir).as_deref() == Some(expected_engine_version)
        && installed_node_version(dir).is_some_and(|node| node_version_is_supported(&node))
}

/// Where `runtime/current` points right now, if anywhere valid. Prefers the
/// unix symlink target; falls back to the `current.version` marker (the sole
/// source of truth on Windows, which uses no traversable reparse point).
pub fn current_runtime_version() -> Option<String> {
    let runtime_id = current_runtime_pointer_version()?;
    runtime_dir_is_valid(&runtime_id, OPENCLAW_ENGINE_VERSION).then_some(runtime_id)
}

/// Polling hint only: this does not authenticate Node or authorize a launch.
/// Full runtime verification remains mandatory before recovery is consumed.
#[derive(Debug, PartialEq, Eq)]
pub struct UnverifiedRecoveryRuntimeIdentity(String);
impl UnverifiedRecoveryRuntimeIdentity {
    pub fn matches_runtime(&self, runtime: &str) -> bool {
        self.0 == runtime
    }
}

pub fn unverified_recovery_runtime_identity() -> Option<UnverifiedRecoveryRuntimeIdentity> {
    let base = runtime_paths::runtime_base_dir().ok()?;
    unverified_recovery_runtime_identity_at(&base)
}

fn unverified_recovery_runtime_identity_at(
    base: &Path,
) -> Option<UnverifiedRecoveryRuntimeIdentity> {
    let runtime_id = current_runtime_pointer_version_at(base)?;
    let dir = base.join(format!("v{runtime_id}"));
    if dir.join(INSTALLING_MARKER).try_exists().ok()?
        || !runtime_shim_path(&dir).is_file()
        || installed_openclaw_version(&dir).as_deref() != Some(OPENCLAW_ENGINE_VERSION)
        || !runtime_node_path(&dir).is_file()
    {
        return None;
    }
    Some(UnverifiedRecoveryRuntimeIdentity(runtime_id))
}

fn current_runtime_pointer_version() -> Option<String> {
    current_runtime_pointer_version_at(&runtime_paths::runtime_base_dir().ok()?)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RuntimePointerSource {
    Link(PathBuf),
    Marker(String),
}
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
struct RuntimePointer {
    runtime_id: String,
    source: RuntimePointerSource,
}

fn current_runtime_pointer_version_at(base: &Path) -> Option<String> {
    selected_runtime_pointer_at(base).map(|pointer| pointer.runtime_id)
}

fn selected_runtime_pointer_at(base: &Path) -> Option<RuntimePointer> {
    if let Some((runtime_id, target)) =
        fs::read_link(base.join("current")).ok().and_then(|target| {
            let runtime_id = target
                .file_name()?
                .to_string_lossy()
                .strip_prefix('v')?
                .to_owned();
            Some((runtime_id, target))
        })
    {
        return Some(RuntimePointer {
            runtime_id,
            source: RuntimePointerSource::Link(target),
        });
    }
    let marker = fs::read_to_string(base.join("current.version")).ok()?;
    let runtime_id = marker.trim().to_owned();
    if runtime_id.is_empty() {
        return None;
    }
    Some(RuntimePointer {
        runtime_id,
        source: RuntimePointerSource::Marker(marker),
    })
}

pub type BundledRuntimeStatusTuple = (String, String, Option<String>);

/// External observed status only. Operations must use the uncached verifier.
#[cfg(windows)]
pub async fn observed_bundled_runtime_status(
    required: String,
) -> Option<BundledRuntimeStatusTuple> {
    use std::sync::{Arc, OnceLock};
    static CACHE: OnceLock<Arc<Mutex<observed_status::Cache>>> = OnceLock::new();
    let base = runtime_paths::runtime_base_dir().ok();
    observed_status::observe(
        CACHE
            .get_or_init(|| Arc::new(Mutex::new(observed_status::Cache::default())))
            .clone(),
        move || {
            base.as_deref()
                .and_then(|base| observed_status::Snapshot::capture(base, &required))
        },
        |snapshot| runtime_dir_is_valid_at(&snapshot.root, &snapshot.required),
    )
    .await
}

#[cfg(any(windows, test))]
mod observed_status {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::sync::Arc;

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(super) struct FileIdentity {
        pub(super) path: PathBuf,
        pub(super) volume: u64,
        pub(super) id: u64,
        pub(super) len: u64,
        pub(super) creation: [u64; 2],
        pub(super) write: [u64; 2],
    }

    #[cfg(windows)]
    pub(super) fn file_identity(file: &fs::File) -> Option<FileIdentity> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, GetFileType, GetFinalPathNameByHandleW,
            BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DEVICE, FILE_ATTRIBUTE_DIRECTORY,
            FILE_TYPE_DISK,
        };
        // File is the sole owner. The Win32 APIs only borrow this handle.
        let handle = file.as_raw_handle();
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileType(handle) } != FILE_TYPE_DISK
            || unsafe { GetFileInformationByHandle(handle, &mut info) } == 0
            || info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_DEVICE) != 0
        {
            return None;
        }
        let id = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        if id == 0 {
            return None;
        }
        let mut capacity = 260usize;
        let mut path = None;
        for _ in 0..4 {
            let mut buffer = vec![0u16; capacity];
            let len = unsafe {
                GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
            } as usize;
            if len == 0 || len > 32768 {
                return None;
            }
            if len < buffer.len() {
                use std::os::windows::ffi::OsStringExt;
                path = Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len])));
                break;
            }
            capacity = len.checked_add(1)?;
        }
        Some(FileIdentity {
            path: path?,
            volume: u64::from(info.dwVolumeSerialNumber),
            id,
            len: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
            creation: [
                u64::from(info.ftCreationTime.dwHighDateTime),
                u64::from(info.ftCreationTime.dwLowDateTime),
            ],
            write: [
                u64::from(info.ftLastWriteTime.dwHighDateTime),
                u64::from(info.ftLastWriteTime.dwLowDateTime),
            ],
        })
    }

    #[cfg(all(test, unix))]
    pub(super) fn file_identity(file: &fs::File) -> Option<FileIdentity> {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || metadata.ino() == 0 {
            return None;
        }
        // This branch only exercises the platform-independent cache protocol.
        Some(FileIdentity {
            path: PathBuf::new(),
            volume: metadata.dev(),
            id: metadata.ino(),
            len: metadata.len(),
            creation: [metadata.ctime() as u64, metadata.ctime_nsec() as u64],
            write: [metadata.mtime() as u64, metadata.mtime_nsec() as u64],
        })
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(super) struct Snapshot {
        pointer: RuntimePointer,
        pub(super) root: PathBuf,
        canonical_root: PathBuf,
        pub(super) required: String,
        engine_contract: String,
        node_contract: String,
        node: FileIdentity,
        package_path: PathBuf,
        package: FileIdentity,
        package_digest: [u8; 32],
        shim: FileIdentity,
        shim_digest: [u8; 32],
        tuple: BundledRuntimeStatusTuple,
    }
    impl Snapshot {
        pub(super) fn capture(base: &Path, required: &str) -> Option<Self> {
            use std::io::Read;
            if required != OPENCLAW_ENGINE_VERSION {
                return None;
            }
            let pointer = selected_runtime_pointer_at(base)?;
            let root = base.join(format!("v{}", pointer.runtime_id));
            let canonical_root = fs::canonicalize(&root).ok()?;
            if root.join(INSTALLING_MARKER).try_exists().ok()? {
                return None;
            }
            let package = installed_openclaw_package(&root)?;
            if package.version != required {
                return None;
            }
            let node_file = open_runtime_file(&runtime_node_path(&root), true).ok()?;
            let shim_path = runtime_shim_path(&root);
            let mut shim_file = open_runtime_file(&shim_path, false).ok()?;
            let mut shim_bytes = Vec::new();
            shim_file.read_to_end(&mut shim_bytes).ok()?;
            let node_label = fs::read_link(root.join("tools/node"))
                .ok()
                .and_then(|path| {
                    path.file_name()
                        .map(|name| name.to_string_lossy().to_string())
                })
                .map(|name| name.strip_prefix("node-").unwrap_or(&name).to_owned());
            let snapshot = Self {
                pointer,
                root: root.clone(),
                canonical_root,
                required: required.to_owned(),
                engine_contract: OPENCLAW_ENGINE_VERSION.to_owned(),
                node_contract:
                    crate::services::openclaw_runtime_catalog::OPENCLAW_RELEASE_NODE_VERSION
                        .to_owned(),
                node: file_identity(&node_file)?,
                package_path: package.path,
                package: file_identity(&package.file)?,
                package_digest: Sha256::digest(package.bytes).into(),
                shim: file_identity(&shim_file)?,
                shim_digest: Sha256::digest(shim_bytes).into(),
                tuple: (
                    shim_path.to_string_lossy().to_string(),
                    required.to_owned(),
                    node_label,
                ),
            };
            if root.join(INSTALLING_MARKER).try_exists().ok()? {
                return None;
            }
            Some(snapshot)
        }
    }

    #[derive(Default)]
    pub(super) struct Cache {
        entry: Option<Snapshot>,
    }
    impl Cache {
        pub(super) fn get_or_verify(
            &mut self,
            mut capture: impl FnMut() -> Option<Snapshot>,
            verify: impl FnOnce(&Snapshot) -> bool,
        ) -> Option<BundledRuntimeStatusTuple> {
            let Some(before) = capture() else {
                self.entry = None;
                return None;
            };
            if let Some(entry) = self.entry.as_ref().filter(|entry| *entry == &before) {
                return Some(entry.tuple.clone());
            }
            self.entry = None;
            if !verify(&before) {
                return None;
            }
            let after = capture()?;
            if before != after {
                return None;
            }
            let tuple = before.tuple.clone();
            self.entry = Some(before);
            Some(tuple)
        }
    }
    pub(super) async fn observe(
        cache: Arc<Mutex<Cache>>,
        capture: impl FnMut() -> Option<Snapshot> + Send + 'static,
        verify: impl FnOnce(&Snapshot) -> bool + Send + 'static,
    ) -> Option<BundledRuntimeStatusTuple> {
        tokio::task::spawn_blocking(move || {
            // Acquired inside the blocking task: dropping an async waiter cannot
            // release the singleflight lock while its Node probe is still alive.
            cache.lock().ok()?.get_or_verify(capture, verify)
        })
        .await
        .ok()
        .flatten()
    }
}

/// The gateway may start only after `current_runtime_version` has checked the
/// installed package, shim, and embedded Node.js version against the exact
/// engine contract. The pointer may contain an artifact digest.
pub fn active_runtime_is_verified() -> bool {
    active_runtime_version_is_verified(current_runtime_version().as_deref())
}

fn active_runtime_version_is_verified(version: Option<&str>) -> bool {
    version.is_some()
}

/// Atomically point the active runtime at `runtime/v<version>` and record it in
/// the marker file. Unix uses a `runtime/current` symlink; Windows relies solely
/// on the marker (see `runtime_current_dir`).
fn flip_current_pointer(version: &str) -> Result<(), String> {
    let _lifecycle = RUNTIME_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let base = runtime_paths::runtime_base_dir()?;
    fs::create_dir_all(&base).map_err(|e| format!("创建运行时目录失败: {e}"))?;
    // The literal `current` entry (symlink on unix / stale junction on Windows),
    // NOT `runtime_current_dir()` which resolves through the marker on Windows.
    let current = base.join("current");

    #[cfg(unix)]
    {
        let staged = base.join(format!(".current-staging-{}", std::process::id()));
        let _ = fs::remove_file(&staged);
        std::os::unix::fs::symlink(format!("v{version}"), &staged)
            .map_err(|e| format!("创建运行时指针失败: {e}"))?;
        fs::rename(&staged, &current).map_err(|e| format!("切换运行时指针失败: {e}"))?;
    }

    #[cfg(windows)]
    {
        // No reparse point on Windows: `runtime_current_dir` resolves the active
        // version straight from the marker below. Clear any stale junction from
        // an earlier build so it can't shadow the marker.
        remove_current_pointer(&current);
    }

    fs::write(runtime_paths::current_marker_path()?, version)
        .map_err(|e| format!("写入运行时版本标记失败: {e}"))?;
    // Keep the previous version until the new Gateway has connected and passed
    // health. That preserves rollback files if startup fails after activation.
    Ok(())
}

/// Remove only version directories directly under Uniopc's private runtime
/// root. Cleanup is gated on a successful Gateway health connection.
fn prune_stale_runtime_versions_after_health(
    gateway_healthy: bool,
    base: &Path,
    keep: &str,
    mut remove_dir: impl FnMut(&Path) -> std::io::Result<()>,
) -> Vec<String> {
    if !gateway_healthy {
        return Vec::new();
    }
    let keep_dir = format!("v{keep}");
    let entries = match fs::read_dir(base) {
        Ok(entries) => entries,
        Err(error) => return vec![format!("无法读取旧引擎运行文件目录：{error}")],
    };
    let mut failures = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // A directory name is `v` followed by a version/digest token. Never
        // touch current, markers, staging, links, or adjacent user data.
        if !name.starts_with('v')
            || name == keep_dir
            || name.len() < 2
            || !name.as_bytes()[1].is_ascii_digit()
            || !name[1..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        {
            continue;
        }
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => {
                if let Err(error) = remove_dir(&entry.path()) {
                    failures.push(format!("无法清理旧引擎运行文件 {name}：{error}"));
                }
            }
            _ => {}
        }
    }
    failures
}

// Older Windows builds cached immutable engine archives beside the app under
// Local/Uniopc/openclaw-runtime. Only remove digest-named archives; anything
// else in that directory could be user data and must be left alone.
#[cfg(any(windows, test))]
fn prune_legacy_windows_runtime_archive_cache(cache_dir: &Path) -> Vec<String> {
    let entries = match fs::read_dir(cache_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => return vec![format!("无法读取旧引擎缓存：{error}")],
    };
    let mut failures = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(digest) = name.strip_suffix(".gz") else {
            continue;
        };
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        if entry.file_type().is_ok_and(|kind| kind.is_file()) {
            if let Err(error) = fs::remove_file(entry.path()) {
                failures.push(format!("无法清理旧引擎缓存 {name}：{error}"));
            }
        }
    }
    if let Err(error) = fs::remove_dir(cache_dir) {
        if error.kind() != std::io::ErrorKind::DirectoryNotEmpty {
            failures.push(format!("无法移除旧引擎缓存目录：{error}"));
        }
    }
    failures
}

fn record_runtime_cleanup(failures: Vec<String>) {
    let Ok(base) = runtime_paths::runtime_base_dir() else {
        return;
    };
    let warning_path = base.join(CLEANUP_WARNING_FILE);
    if failures.is_empty() {
        let _ = fs::remove_file(warning_path);
    } else {
        let message = format!(
            "旧版本引擎运行文件清理未完成：{}。应用仍可继续使用；下次启动会重试。",
            failures.join("；")
        );
        let _ = fs::write(warning_path, message);
    }
}

pub fn runtime_cleanup_warning() -> Option<String> {
    let path = runtime_paths::runtime_base_dir()
        .ok()?
        .join(CLEANUP_WARNING_FILE);
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Called only after the app has connected to the Gateway and confirmed its
/// health. Keep old runtimes until this point so a failed startup can still be
/// diagnosed or rolled back. Failure is non-fatal and retried at the next
/// healthy connection.
pub fn cleanup_stale_runtime_versions_after_gateway_connected(expected_runtime_id: &str) {
    let _lifecycle = RUNTIME_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if current_runtime_version().as_deref() != Some(expected_runtime_id) {
        return;
    }
    let Ok(base) = runtime_paths::runtime_base_dir() else {
        return;
    };
    let failures =
        prune_stale_runtime_versions_after_health(true, &base, expected_runtime_id, |path| {
            fs::remove_dir_all(path)
        });
    #[cfg(windows)]
    let failures = {
        let mut failures = failures;
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let legacy_cache = PathBuf::from(local_app_data)
                .join("Uniopc")
                .join("openclaw-runtime");
            failures.extend(prune_legacy_windows_runtime_archive_cache(&legacy_cache));
        }
        failures
    };
    record_runtime_cleanup(failures);
}

/// Remove the `current` reparse point (junction/symlink) without deleting the
/// version dir it targets. `remove_dir` unlinks a junction in place;
/// `remove_file` covers a symlink; a stray real dir is cleared last.
#[cfg(windows)]
fn remove_current_pointer(current: &Path) {
    if !current.exists() && fs::symlink_metadata(current).is_err() {
        return;
    }
    if fs::remove_dir(current).is_ok() {
        return;
    }
    if fs::remove_file(current).is_ok() {
        return;
    }
    let _ = fs::remove_dir_all(current);
}

/// The `tar` to shell out to. macOS and Windows 10+ both ship bsdtar, but on
/// Windows resolve it by absolute path (System32\tar.exe) rather than the bare
/// `tar` on PATH: a dev/CI shell (git-bash, MSYS) can shadow it with GNU tar,
/// which can't extract the deep nested node_modules paths in the runtime archive
/// (it fails creating `\\?\C:\...` long paths). bsdtar handles them. Falls back
/// to `tar` when the system copy is somehow absent.
fn tar_program() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("windir"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        let system_tar = root.join("System32").join("tar.exe");
        if system_tar.exists() {
            return system_tar;
        }
    }
    PathBuf::from("tar")
}

/// Bounded retries for platforms which commit installation by renaming staging.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last: std::io::Result<()> = Ok(());
    for attempt in 0..5u32 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last = Err(error);
                std::thread::sleep(std::time::Duration::from_millis(
                    150 * u64::from(attempt + 1),
                ));
            }
        }
    }
    last
}

/// Windows denies renaming a tree while a descendant is open, even with
/// FILE_SHARE_DELETE. In the 0.4.18 VM trace, running staged node.exe --version
/// triggered DiagTrack opens/mappings which outlived the probe and all retries.
/// Extract into the immutable destination
/// instead, guarded by a marker which excludes partial installs from activation.
/// Unix retains atomic staging/rename. Neither path changes the active pointer.
fn install_runtime_directory(
    staging: &Path,
    destination: &Path,
    direct: bool,
    install: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let work = if direct { destination } else { staging };
    if work.exists() {
        fs::remove_dir_all(work).map_err(|error| {
            format!("清理未完成的运行时目录失败（{}）: {error}", work.display())
        })?;
    }
    fs::create_dir_all(work)
        .map_err(|error| format!("创建运行时目录失败（{}）: {error}", work.display()))?;
    fs::write(work.join(INSTALLING_MARKER), b"pending verification\n")
        .map_err(|error| format!("记录运行时安装状态失败: {error}"))?;
    let cleanup_failure = |error: String| {
        // Direct Windows installs keep one marked, non-active directory for
        // the next explicit retry. Do not accumulate Unix staging directories.
        if !direct {
            if let Err(cleanup) = fs::remove_dir_all(work) {
                return format!("{error}; 清理暂存目录失败（{}）: {cleanup}", work.display());
            }
        }
        error
    };
    install(work).map_err(&cleanup_failure)?;
    if !direct {
        if destination.exists() {
            fs::remove_dir_all(destination).map_err(|error| {
                cleanup_failure(format!(
                    "清理旧的运行时目标目录失败（{}）: {error}",
                    destination.display()
                ))
            })?;
        }
        rename_with_retry(work, destination).map_err(|error| {
            cleanup_failure(format!(
                "落位运行时版本目录失败（{} -> {}）: {error}",
                work.display(),
                destination.display()
            ))
        })?;
    }
    fs::remove_file(destination.join(INSTALLING_MARKER))
        .map_err(|error| format!("完成运行时安装校验失败: {error}"))?;
    Ok(())
}

fn extract_archive(archive: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| format!("创建运行时解压目录失败: {e}"))?;
    let mut command = Command::new(tar_program());
    command.arg("-xzf").arg(archive).arg("-C").arg(destination);
    crate::services::openclaw_cli::hide_console(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("启动 tar 解压失败: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "解压内置运行时失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

fn extract_verified_archive(
    artifact: &RuntimeArtifact,
    archive: &Path,
    destination: &Path,
    cached: &mut Option<VerifiedArchive>,
) -> Result<(), String> {
    // Re-read and hash before every extraction, even if activation previously
    // verified this fingerprint. Failed verification never creates staging.
    *cached = None;
    verify_archive_cached(artifact, archive, cached)?;
    extract_archive(archive, destination)
}

/// Prefer the verified bundled artifact when one is present, including a
/// repaired artifact with the same upstream engine version. A valid existing
/// private runtime remains usable when the checkout has no bundled catalog;
/// this never probes a system-wide install.
pub fn ensure_runtime_ready(app: &AppHandle) -> Result<(), String> {
    prepare_runtime_if_needed(active_runtime_is_verified(), || {
        ensure_bundled_runtime_installed(app)
    })
}

fn prepare_runtime_if_needed(
    active_verified: bool,
    activate: impl FnOnce() -> Result<BundledRuntimeOutcome, String>,
) -> Result<(), String> {
    match activate()? {
        BundledRuntimeOutcome::Unavailable { .. } if active_verified => Ok(()),
        BundledRuntimeOutcome::Unavailable { reason } => Err(reason),
        BundledRuntimeOutcome::AlreadyExtracted { .. }
        | BundledRuntimeOutcome::Extracted { .. } => Ok(()),
    }
}

/// Install (or activate) the bundled runtime artifact. Idempotent: a valid
/// `runtime/v<version>-<digest>` that `current` already points at is a no-op;
/// an existing valid artifact dir that lost the pointer is just re-pointed.
pub fn ensure_bundled_runtime_installed(app: &AppHandle) -> Result<BundledRuntimeOutcome, String> {
    // Serialize before archive I/O: a concurrent caller reuses verification
    // completed by the first activation, rather than hashing the same archive.
    let mut verified_archive = ACTIVATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (artifact, archive) = match select_bundled_runtime_archive(app) {
        Ok(found) => found,
        Err(reason) => return Ok(BundledRuntimeOutcome::Unavailable { reason }),
    };
    let runtime_id = artifact_runtime_id(&artifact)?;
    let installed_valid = runtime_dir_is_valid(&runtime_id, &artifact.version);
    if installed_valid {
        let stamp_path = verified_archive_stamp_path()?;
        if !persisted_archive_is_verified(&artifact, &archive, &stamp_path)? {
            verify_archive_cached(&artifact, &archive, &mut verified_archive)?;
            // A cache-write failure only loses the fast path; it must not block
            // a verified runtime from starting.
            let _ = store_verified_archive_stamp_at(
                &stamp_path,
                verified_archive.as_ref().expect("verified archive"),
            );
        }
        if current_runtime_pointer_version().as_deref() == Some(runtime_id.as_str()) {
            return Ok(BundledRuntimeOutcome::AlreadyExtracted {
                version: artifact.version,
            });
        }
    } else {
        let base = runtime_paths::runtime_base_dir()?;
        let staging = base.join(format!(
            ".extract-staging-{}-{}",
            std::process::id(),
            STAGING_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let version_dir = runtime_paths::runtime_version_dir(&runtime_id)?;
        install_runtime_directory(&staging, &version_dir, cfg!(windows), |work| {
            extract_verified_archive(&artifact, &archive, work, &mut verified_archive)?;
            let staged_version = installed_openclaw_version(work)
                .ok_or_else(|| "解压后的内置运行时缺少引擎包版本信息。".to_string())?;
            if staged_version != artifact.version {
                return Err(format!(
                    "内置运行时版本不一致: 清单为 {}，压缩包内为 {staged_version}。",
                    artifact.version
                ));
            }
            let staged_node = installed_node_version(work)
                .ok_or_else(|| "解压后的内置运行时缺少 Node.js 版本信息。".to_string())?;
            if !node_version_is_supported(&staged_node)
                || staged_node.trim_start_matches('v')
                    != artifact.node_version.trim_start_matches('v')
            {
                return Err(format!(
                    "解压后的 Node.js 版本 {staged_node} 不满足 Uniopc 引擎 8.1 运行时要求。"
                ));
            }
            for subtree in RUNTIME_SUBTREES {
                if !work.join(subtree).exists() {
                    return Err(format!("内置运行时缺少 {subtree}/ 子目录。"));
                }
            }
            Ok(())
        })?;
        if let Ok(stamp_path) = verified_archive_stamp_path() {
            if let Some(fingerprint) = verified_archive.as_ref() {
                // The extraction path has just performed a mandatory full
                // digest verification, so seed the next-process fast path.
                let _ = store_verified_archive_stamp_at(&stamp_path, fingerprint);
            }
        }
    }

    flip_current_pointer(&runtime_id)?;
    Ok(BundledRuntimeOutcome::Extracted {
        version: artifact.version,
    })
}

/// Warm-start fast check used by the status fast path: true when
/// `runtime/current` resolves to a valid install of `version`.
pub fn active_runtime_matches(version: &str) -> bool {
    active_runtime_matches_with(version, current_runtime_version)
}

fn active_runtime_matches_with(version: &str, verify: impl FnOnce() -> Option<String>) -> bool {
    version == OPENCLAW_ENGINE_VERSION && verify().is_some()
}

/// Point `runtime/current` at an already-installed version dir (used after
/// the network-installer fallback populates `runtime/v<version>` directly).
pub fn activate_runtime_version(version: &str) -> Result<(), String> {
    if !runtime_dir_is_valid(version, version) {
        return Err(format!("运行时版本目录无效或缺失: v{version}"));
    }
    flip_current_pointer(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_status_active_matches_requires_exact_pin_and_one_full_validation() {
        use std::cell::Cell;
        let calls = Cell::new(0);
        let verify = || {
            calls.set(calls.get() + 1);
            Some("artifact-runtime-id".to_owned())
        };
        assert!(!active_runtime_matches_with("wrong", verify));
        assert_eq!(calls.get(), 0);
        assert!(active_runtime_matches_with(OPENCLAW_ENGINE_VERSION, verify));
        assert_eq!(calls.get(), 1);
        assert!(!active_runtime_matches_with(
            OPENCLAW_ENGINE_VERSION,
            || None
        ));
    }

    struct StatusFixture {
        base: PathBuf,
        root: PathBuf,
    }
    impl StatusFixture {
        fn new() -> Self {
            use std::sync::OnceLock;
            static NODE_FIXTURE: OnceLock<PathBuf> = OnceLock::new();
            let binary = NODE_FIXTURE.get_or_init(|| {
                let dir = std::env::temp_dir().join(format!("uniopc-status-node-{}", uuid::Uuid::new_v4()));
                fs::create_dir_all(&dir).unwrap();
                let source = dir.join("fixture.rs");
                fs::write(&source, r#"
use std::io::Write;
fn main() {
    assert_eq!(std::env::args().nth(1).as_deref(), Some("--version"));
    let counter = std::env::current_exe().unwrap().with_file_name("probes");
    writeln!(std::fs::OpenOptions::new().create(true).append(true).open(counter).unwrap(), "probe").unwrap();
    println!("v24.19.0");
}
"#).unwrap();
                let binary = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
                let output = Command::new("rustc").arg("--crate-name").arg("status_node_fixture")
                    .arg(&source).arg("-o").arg(&binary).output().unwrap();
                assert!(output.status.success(), "fixture rustc: {}", String::from_utf8_lossy(&output.stderr));
                binary
            });
            let base = std::env::temp_dir().join(format!("uniopc-status-{}", uuid::Uuid::new_v4()));
            let root = base.join("vfixture");
            let package = root.join("tools/node/node_modules/uniopc-engine/package.json");
            fs::create_dir_all(package.parent().unwrap()).unwrap();
            fs::create_dir_all(runtime_shim_path(&root).parent().unwrap()).unwrap();
            fs::create_dir_all(runtime_node_path(&root).parent().unwrap()).unwrap();
            fs::copy(binary, runtime_node_path(&root)).unwrap();
            fs::write(
                &package,
                serde_json::json!({"version": OPENCLAW_ENGINE_VERSION}).to_string(),
            )
            .unwrap();
            fs::write(runtime_shim_path(&root), "shim fixture").unwrap();
            fs::write(base.join("current.version"), "fixture").unwrap();
            Self { base, root }
        }
        fn snapshot(&self) -> Option<observed_status::Snapshot> {
            observed_status::Snapshot::capture(&self.base, OPENCLAW_ENGINE_VERSION)
        }
        fn probes(&self) -> usize {
            fs::read_to_string(runtime_node_path(&self.root).with_file_name("probes"))
                .unwrap_or_default()
                .lines()
                .count()
        }
        fn observe(&self, cache: &mut observed_status::Cache) -> Option<BundledRuntimeStatusTuple> {
            cache.get_or_verify(
                || self.snapshot(),
                |snapshot| runtime_dir_is_valid_at(&snapshot.root, &snapshot.required),
            )
        }
        fn package(&self) -> PathBuf {
            self.root
                .join("tools/node/node_modules/uniopc-engine/package.json")
        }
    }
    impl Drop for StatusFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn windows_status_complete_tuple_cached_only_after_one_full_probe() {
        let fixture = StatusFixture::new();
        let mut cache = observed_status::Cache::default();
        let expected = fixture.observe(&mut cache).unwrap();
        for _ in 0..100 {
            assert_eq!(fixture.observe(&mut cache), Some(expected.clone()));
        }
        assert_eq!(fixture.probes(), 1);
        // The operation verifier has no dependency on the observation cache.
        assert!(runtime_dir_is_valid_at(
            &fixture.root,
            OPENCLAW_ENGINE_VERSION
        ));
        assert!(runtime_dir_is_valid_at(
            &fixture.root,
            OPENCLAW_ENGINE_VERSION
        ));
        assert_eq!(fixture.probes(), 3);
        assert!(observed_status::Snapshot::capture(&fixture.base, "wrong requested pin").is_none());
        assert_eq!(fixture.probes(), 3);
    }

    #[test]
    fn windows_status_marker_pointer_package_shim_and_query_failures_invalidate() {
        let fixture = StatusFixture::new();
        let mut cache = observed_status::Cache::default();
        fixture.observe(&mut cache).unwrap();
        fs::write(fixture.root.join(INSTALLING_MARKER), "installing").unwrap();
        assert!(fixture.observe(&mut cache).is_none());
        assert_eq!(fixture.probes(), 1);
        fs::remove_file(fixture.root.join(INSTALLING_MARKER)).unwrap();
        fixture.observe(&mut cache).unwrap();
        assert_eq!(fixture.probes(), 2);
        fs::write(
            fixture.package(),
            format!(
                "{{\"version\":\"{}\",\"extra\":true}}",
                OPENCLAW_ENGINE_VERSION
            ),
        )
        .unwrap();
        fixture.observe(&mut cache).unwrap();
        assert_eq!(fixture.probes(), 3);
        fs::write(runtime_shim_path(&fixture.root), "new shim fixture").unwrap();
        fixture.observe(&mut cache).unwrap();
        assert_eq!(fixture.probes(), 4);
        // Any unavailable identity/query invalidates the positive entry.
        assert!(cache
            .get_or_verify(|| None, |_| panic!("no full probe on snapshot error"))
            .is_none());
        fixture.observe(&mut cache).unwrap();
        assert_eq!(fixture.probes(), 5);
        fs::write(fixture.base.join("current.version"), "missing").unwrap();
        assert!(fixture.observe(&mut cache).is_none());
        fs::write(fixture.base.join("current.version"), "fixture").unwrap();
        fixture.observe(&mut cache).unwrap();
        assert_eq!(fixture.probes(), 6);
        fs::write(fixture.package(), r#"{"version":"unsupported"}"#).unwrap();
        assert!(fixture.observe(&mut cache).is_none());
        assert_eq!(fixture.probes(), 6);
        fs::remove_file(fixture.package()).unwrap();
        assert!(fixture.observe(&mut cache).is_none());
    }

    #[test]
    fn windows_status_resolver_uses_selected_fallback_package_bytes() {
        let fixture = StatusFixture::new();
        // The same resolver skips invalid JSON in the preferred layout.
        let preferred = fixture
            .root
            .join("tools/node/lib/node_modules/uniopc-engine/package.json");
        fs::create_dir_all(preferred.parent().unwrap()).unwrap();
        fs::write(&preferred, "invalid JSON").unwrap();
        assert_eq!(
            installed_openclaw_package(&fixture.root).unwrap().path,
            fixture.package()
        );
        let mut cache = observed_status::Cache::default();
        fixture.observe(&mut cache).unwrap();
        fs::write(
            &preferred,
            serde_json::json!({"version": OPENCLAW_ENGINE_VERSION}).to_string(),
        )
        .unwrap();
        assert_eq!(
            installed_openclaw_package(&fixture.root).unwrap().path,
            preferred
        );
        fixture.observe(&mut cache).unwrap();
        assert_eq!(fixture.probes(), 2);
        fs::remove_file(&preferred).unwrap();
        fs::remove_file(fixture.package()).unwrap();
        let fallback = fixture
            .root
            .join("tools/other/node_modules/uniopc-engine/package.json");
        fs::create_dir_all(fallback.parent().unwrap()).unwrap();
        fs::write(
            &fallback,
            serde_json::json!({"version": OPENCLAW_ENGINE_VERSION}).to_string(),
        )
        .unwrap();
        assert_eq!(
            installed_openclaw_package(&fixture.root).unwrap().path,
            fallback
        );
        fixture.observe(&mut cache).unwrap();
        assert_eq!(fixture.probes(), 3);
        fs::write(
            &fallback,
            format!(
                "{{\"version\":\"{}\",\"changed\":1}}",
                OPENCLAW_ENGINE_VERSION
            ),
        )
        .unwrap();
        fixture.observe(&mut cache).unwrap();
        assert_eq!(fixture.probes(), 4);
    }

    #[test]
    fn windows_status_validation_change_never_publishes_mixed_tuple_or_negative_cache() {
        let fixture = StatusFixture::new();
        let other = StatusFixture::new();
        let next_root = fixture.base.join("vnext");
        fs::rename(&other.root, &next_root).unwrap();
        let mut cache = observed_status::Cache::default();
        assert!(cache
            .get_or_verify(
                || fixture.snapshot(),
                |snapshot| {
                    assert!(runtime_dir_is_valid_at(&snapshot.root, &snapshot.required));
                    fs::write(fixture.base.join("current.version"), "next").unwrap();
                    true
                }
            )
            .is_none());
        assert_eq!(fixture.probes(), 1);
        let next_tuple = fixture.observe(&mut cache).unwrap();
        assert_eq!(
            next_tuple.0,
            runtime_shim_path(&next_root).to_string_lossy()
        );
        assert_eq!(
            fs::read_to_string(runtime_node_path(&next_root).with_file_name("probes"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        fs::write(fixture.base.join("current.version"), "fixture").unwrap();
        assert!(cache
            .get_or_verify(|| fixture.snapshot(), |_| false)
            .is_none());
        assert!(fixture.observe(&mut cache).is_some());
        assert_eq!(fixture.probes(), 2);
    }

    #[test]
    fn windows_status_same_length_and_write_time_replacement_changes_identity() {
        let fixture = StatusFixture::new();
        let mut cache = observed_status::Cache::default();
        fixture.observe(&mut cache).unwrap();
        let node = runtime_node_path(&fixture.root);
        let before =
            observed_status::file_identity(&open_runtime_file(&node, true).unwrap()).unwrap();
        let modified = fs::metadata(&node).unwrap().modified().unwrap();
        let replacement = node.with_file_name("replacement");
        fs::copy(&node, &replacement).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        fs::remove_file(&node).unwrap();
        fs::rename(&replacement, &node).unwrap();
        let after =
            observed_status::file_identity(&open_runtime_file(&node, true).unwrap()).unwrap();
        assert_eq!(before.len, after.len);
        assert_eq!(before.write, after.write);
        assert_ne!(before.id, after.id);
        assert!(fixture.observe(&mut cache).is_some());
        assert_eq!(fixture.probes(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn windows_status_cancelled_leader_and_twenty_waiters_share_one_full_probe() {
        use std::sync::{Arc, Condvar};
        let fixture = Arc::new(StatusFixture::new());
        let cache = Arc::new(Mutex::new(observed_status::Cache::default()));
        let entered = Arc::new(tokio::sync::Notify::new());
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let leader = {
            let (fixture, cache, entered, gate) = (
                fixture.clone(),
                cache.clone(),
                entered.clone(),
                gate.clone(),
            );
            tokio::spawn(async move {
                let capture_fixture = fixture.clone();
                observed_status::observe(
                    cache,
                    move || capture_fixture.snapshot(),
                    move |snapshot| {
                        entered.notify_one();
                        let (mutex, condvar) = &*gate;
                        let mut released = mutex.lock().unwrap();
                        while !*released {
                            released = condvar.wait(released).unwrap();
                        }
                        runtime_dir_is_valid_at(&snapshot.root, &snapshot.required)
                    },
                )
                .await
            })
        };
        entered.notified().await;
        leader.abort();
        let mut waiters = Vec::new();
        for _ in 0..20 {
            let (fixture, cache) = (fixture.clone(), cache.clone());
            waiters.push(tokio::spawn(async move {
                observed_status::observe(
                    cache,
                    move || fixture.snapshot(),
                    |snapshot| runtime_dir_is_valid_at(&snapshot.root, &snapshot.required),
                )
                .await
            }));
        }
        tokio::task::yield_now().await;
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        for waiter in waiters {
            assert!(waiter.await.unwrap().is_some());
        }
        assert_eq!(fixture.probes(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_status_native_identity_failure_does_not_hit_or_publish() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = StatusFixture::new();
        let mut cache = observed_status::Cache::default();
        fixture.observe(&mut cache).unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(runtime_shim_path(&fixture.root))
            .unwrap();
        assert!(fixture.observe(&mut cache).is_none());
        drop(held);
        fixture.observe(&mut cache).unwrap();
        assert_eq!(fixture.probes(), 2);
        assert!(observed_status::file_identity(&fs::File::open("NUL").unwrap()).is_none());
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&fixture.root)
            .unwrap();
        assert!(observed_status::file_identity(&directory).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_status_native_handle_fixture() {
        if std::env::var_os("UNIOPC_STATUS_HANDLE_FIXTURE").is_none() {
            return;
        }
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};
        let fixture = StatusFixture::new();
        fixture.snapshot().unwrap();
        let count = || {
            let mut count = 0;
            assert_ne!(
                unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) },
                0
            );
            count
        };
        let before = count();
        for _ in 0..1000 {
            fixture.snapshot().unwrap();
        }
        assert_eq!(
            count(),
            before,
            "File RAII must close every identity-query handle"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_status_native_handle_queries_do_not_leak() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "services::openclaw_bundled_runtime::tests::windows_status_native_handle_fixture",
                "--test-threads=1",
                "--nocapture",
            ])
            .env("UNIOPC_STATUS_HANDLE_FIXTURE", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn recovery_await_boundaries_reject_replaced_node_and_runtime() {
        use std::os::unix::fs::PermissionsExt;
        for boundary in ["before_spawn", "before_activation"] {
            for changed in ["node", "runtime"] {
                let root =
                    std::env::temp_dir().join(format!("uniopc-await-{}", uuid::Uuid::new_v4()));
                let dir = root.join("vfixture");
                let package = dir.join("tools/node/node_modules/uniopc-engine/package.json");
                fs::create_dir_all(package.parent().unwrap()).unwrap();
                fs::create_dir_all(runtime_node_path(&dir).parent().unwrap()).unwrap();
                fs::create_dir_all(runtime_shim_path(&dir).parent().unwrap()).unwrap();
                fs::write(root.join("current.version"), "fixture").unwrap();
                fs::write(runtime_shim_path(&dir), "shim").unwrap();
                fs::write(
                    &package,
                    serde_json::json!({"version": OPENCLAW_ENGINE_VERSION}).to_string(),
                )
                .unwrap();
                let node = runtime_node_path(&dir);
                fs::write(&node, "#!/bin/sh\nprintf 'v24.19.0\\n'\n").unwrap();
                fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
                assert!(runtime_dir_is_valid_at(&dir, OPENCLAW_ENGINE_VERSION));
                // Simulate replacement while termination/reaping or spawn is awaited.
                let mutation_dir = dir.clone();
                tokio::spawn(async move {
                    tokio::task::yield_now().await;
                    if changed == "node" {
                        fs::write(
                            runtime_node_path(&mutation_dir),
                            "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
                        )
                        .unwrap();
                    } else {
                        fs::write(
                            mutation_dir.join("tools/node/node_modules/uniopc-engine/package.json"),
                            r#"{"version":"changed"}"#,
                        )
                        .unwrap();
                    }
                })
                .await
                .unwrap();
                // The cheap hint deliberately cannot authenticate a replaced Node.
                assert_eq!(
                    unverified_recovery_runtime_identity_at(&root).is_some(),
                    changed == "node"
                );
                let mut spawned = boundary == "before_activation";
                let mut activated = false;
                if runtime_dir_is_valid_at(&dir, OPENCLAW_ENGINE_VERSION) {
                    if boundary == "before_spawn" {
                        spawned = true;
                    } else {
                        activated = true;
                    }
                }
                assert_eq!(
                    spawned,
                    boundary == "before_activation",
                    "{boundary}: {changed} replacement must block spawn"
                );
                assert!(
                    !activated,
                    "{boundary}: {changed} replacement must block activation"
                );
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn recovery_identity_is_filesystem_only_and_rejects_incomplete_runtime() {
        let root = std::env::temp_dir().join(format!("uniopc-poll-{}", uuid::Uuid::new_v4()));
        let dir = root.join("vfixture");
        fs::create_dir_all(dir.join("tools/node/node_modules/uniopc-engine")).unwrap();
        fs::create_dir_all(runtime_shim_path(&dir).parent().unwrap()).unwrap();
        fs::create_dir_all(runtime_node_path(&dir).parent().unwrap()).unwrap();
        fs::write(root.join("current.version"), "fixture").unwrap();
        fs::write(runtime_shim_path(&dir), "shim").unwrap();
        // Deliberately not an executable: polling cannot run this fake Node.
        fs::write(runtime_node_path(&dir), "not executable").unwrap();
        let package = dir.join("tools/node/node_modules/uniopc-engine/package.json");
        fs::write(
            &package,
            serde_json::json!({"version": OPENCLAW_ENGINE_VERSION}).to_string(),
        )
        .unwrap();
        for _ in 0..400 {
            assert!(unverified_recovery_runtime_identity_at(&root)
                .unwrap()
                .matches_runtime("fixture"));
        }
        fs::write(dir.join(INSTALLING_MARKER), "").unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::remove_file(dir.join(INSTALLING_MARKER)).unwrap();
        fs::write(&package, "invalid json").unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::write(&package, r#"{"version":"wrong"}"#).unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::write(
            &package,
            serde_json::json!({"version": OPENCLAW_ENGINE_VERSION}).to_string(),
        )
        .unwrap();
        fs::remove_file(runtime_node_path(&dir)).unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::write(runtime_node_path(&dir), "not executable").unwrap();
        fs::remove_file(runtime_shim_path(&dir)).unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::write(runtime_shim_path(&dir), "shim").unwrap();
        fs::write(root.join("current.version"), "different").unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("vfixture", root.join("current")).unwrap();
            assert!(unverified_recovery_runtime_identity_at(&root)
                .unwrap()
                .matches_runtime("fixture"));
            fs::remove_file(root.join("current")).unwrap();
        }
        fs::remove_file(root.join("current.version")).unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_windows_cache_cleanup_keeps_unrecognized_files() {
        let root =
            std::env::temp_dir().join(format!("uniopc-legacy-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let archive = root.join(format!("{}.gz", "a".repeat(64)));
        fs::write(&archive, b"old archive").unwrap();
        let unrelated = root.join("notes.txt");
        fs::write(&unrelated, b"keep").unwrap();
        assert!(prune_legacy_windows_runtime_archive_cache(&root).is_empty());
        assert!(!archive.exists());
        assert!(unrelated.exists());
        fs::remove_file(unrelated).unwrap();
        fs::remove_dir(root).unwrap();

        let emptyable =
            std::env::temp_dir().join(format!("uniopc-legacy-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&emptyable).unwrap();
        fs::write(
            emptyable.join(format!("{}.gz", "b".repeat(64))),
            b"old archive",
        )
        .unwrap();
        assert!(prune_legacy_windows_runtime_archive_cache(&emptyable).is_empty());
        assert!(!emptyable.exists());
    }

    #[test]
    fn stale_runtime_cleanup_waits_for_healthy_gateway_then_retries_after_failure() {
        let root = std::env::temp_dir().join(format!("uniopc-prune-{}", uuid::Uuid::new_v4()));
        let runtime = root.join("runtime");
        let active = runtime.join("v2.0.0-new");
        let stale = runtime.join("v1.0.0-old");
        let unrelated = runtime.join("v-not-a-version");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&stale).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        fs::create_dir_all(root.join("state-v8")).unwrap();
        fs::create_dir_all(root.join("workspace")).unwrap();
        fs::write(active.join("engine"), "active").unwrap();
        fs::write(stale.join("engine"), "old").unwrap();
        fs::write(unrelated.join("keep"), "not an install").unwrap();

        let before_health =
            prune_stale_runtime_versions_after_health(false, &runtime, "2.0.0-new", |_| {
                panic!("cleanup must not run before Gateway health succeeds")
            });
        assert!(before_health.is_empty());
        assert!(
            stale.exists(),
            "pending/failed Gateway startup retains rollback runtime"
        );

        let failures =
            prune_stale_runtime_versions_after_health(true, &runtime, "2.0.0-new", |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "fixture lock",
                ))
            });
        assert_eq!(failures.len(), 1);
        assert!(stale.exists(), "failed cleanup keeps the old dir for retry");
        assert!(
            active.join("engine").exists(),
            "active runtime is never removed"
        );
        assert!(
            unrelated.join("keep").exists(),
            "non-version entries are untouched"
        );
        assert!(root.join("state-v8").exists());
        assert!(root.join("workspace").exists());

        let failures =
            prune_stale_runtime_versions_after_health(true, &runtime, "2.0.0-new", |path| {
                fs::remove_dir_all(path)
            });
        assert!(failures.is_empty());
        assert!(
            !stale.exists(),
            "subsequent cleanup retry removes stale runtime"
        );
        assert!(active.exists());
        assert!(unrelated.exists());
        assert!(root.join("state-v8").exists());
        assert!(root.join("workspace").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn direct_install_survives_a_diagtrack_style_open_descendant() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = std::env::temp_dir().join(format!("uniopc-open-tree-{}", uuid::Uuid::new_v4()));
        let destination = root.join("runtime");
        let staging = root.join("staging");
        let mut held_file = None;
        install_runtime_directory(&staging, &destination, true, |dir| {
            let node = dir.join("node-probe.txt");
            fs::write(&node, "fixture").unwrap();
            // Match the observed DiagTrack handle: Generic Read, share Read +
            // Delete. Sharing deletion of a file still blocks its parent move.
            held_file = Some(
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0x1 | 0x4)
                    .open(node)
                    .unwrap(),
            );
            let error = fs::rename(dir, &staging).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(5));
            Ok(())
        })
        .unwrap();
        assert!(!destination.join(INSTALLING_MARKER).exists());
        assert!(!staging.exists());
        assert_eq!(
            fs::read_to_string(destination.join("node-probe.txt")).unwrap(),
            "fixture"
        );
        drop(held_file);
        fs::rename(&destination, &staging).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_direct_install_is_not_completed_and_can_be_retried() {
        let root = std::env::temp_dir().join(format!("uniopc-install-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let pointer = root.join("current.version");
        fs::write(&pointer, "old-verified-runtime").unwrap();
        let destination = root.join("new-runtime");
        let staging = root.join("staging");
        let result = install_runtime_directory(&staging, &destination, true, |dir| {
            fs::write(dir.join("partial"), "incomplete").unwrap();
            Err("simulated validation failure".into())
        });
        assert!(result.is_err());
        assert!(destination.join(INSTALLING_MARKER).exists());
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            "old-verified-runtime"
        );
        install_runtime_directory(&staging, &destination, true, |dir| {
            assert!(!dir.join("partial").exists());
            fs::write(dir.join("complete"), "verified").unwrap();
            Ok(())
        })
        .unwrap();
        assert!(!destination.join(INSTALLING_MARKER).exists());
        assert!(destination.join("complete").exists());
        assert!(
            !staging.exists(),
            "Windows path must not need a tree rename"
        );
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            "old-verified-runtime"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staging_failure_preserves_the_existing_destination() {
        let root = std::env::temp_dir().join(format!("uniopc-stage-{}", uuid::Uuid::new_v4()));
        let destination = root.join("destination");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("old"), "keep").unwrap();
        let result = install_runtime_directory(&root.join("staging"), &destination, false, |_| {
            Err("bad archive".into())
        });
        assert!(result.is_err());
        assert!(destination.join("old").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verified_private_runtime_tolerates_a_missing_bundle() {
        prepare_runtime_if_needed(true, || {
            Ok(BundledRuntimeOutcome::Unavailable {
                reason: "bundle missing".into(),
            })
        })
        .unwrap();
    }

    #[test]
    fn verified_private_runtime_still_activates_a_repaired_bundle() {
        assert!(prepare_runtime_if_needed(true, || {
            Ok(BundledRuntimeOutcome::Extracted {
                version: OPENCLAW_ENGINE_VERSION.into(),
            })
        })
        .is_ok());
    }

    #[test]
    fn unverified_private_runtime_requires_successful_offline_activation() {
        let unavailable = prepare_runtime_if_needed(false, || {
            Ok(BundledRuntimeOutcome::Unavailable {
                reason: "bundle missing".into(),
            })
        });
        assert_eq!(unavailable.unwrap_err(), "bundle missing");
        assert_eq!(
            prepare_runtime_if_needed(false, || Err("archive invalid".into())).unwrap_err(),
            "archive invalid"
        );
        assert!(prepare_runtime_if_needed(false, || {
            Ok(BundledRuntimeOutcome::Extracted {
                version: OPENCLAW_ENGINE_VERSION.into(),
            })
        })
        .is_ok());
    }

    #[test]
    fn extraction_reverifies_even_when_archive_was_cached() {
        use sha2::{Digest, Sha256};
        let root = std::env::temp_dir().join(format!("uniopc-extract-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("payload"), "local runtime").unwrap();
        let archive = root.join("runtime.tar.gz");
        assert!(Command::new(tar_program())
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&source)
            .arg("payload")
            .status()
            .unwrap()
            .success());
        let bytes = fs::read(&archive).unwrap();
        let artifact = RuntimeArtifact {
            version: OPENCLAW_ENGINE_VERSION.into(),
            platform: node_platform().into(),
            arch: node_arch().into(),
            archive: "runtime.tar.gz".into(),
            sha256: hex::encode(Sha256::digest(&bytes)),
            size_bytes: bytes.len() as u64,
            node_version: "24.19.0".into(),
        };
        let mut cache = None;
        verify_archive_cached(&artifact, &archive, &mut cache).unwrap();
        let valid_dest = root.join("valid");
        extract_verified_archive(&artifact, &archive, &valid_dest, &mut cache).unwrap();
        assert_eq!(
            fs::read_to_string(valid_dest.join("payload")).unwrap(),
            "local runtime"
        );
        fs::write(&archive, b"corrupted").unwrap();
        // Even an apparently cached fingerprint cannot authorize extraction.
        cache = Some(archive_fingerprint(&artifact, &archive).unwrap());
        let invalid_dest = root.join("invalid");
        assert!(extract_verified_archive(&artifact, &archive, &invalid_dest, &mut cache).is_err());
        assert!(!invalid_dest.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_archive_is_hashed_once_and_changes_are_rejected() {
        let dir = std::env::temp_dir().join(format!("uniopc-archive-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("runtime.tar.gz");
        fs::write(&archive, b"hello").unwrap();
        let artifact = RuntimeArtifact {
            version: OPENCLAW_ENGINE_VERSION.into(),
            platform: node_platform().into(),
            arch: node_arch().into(),
            archive: "runtime.tar.gz".into(),
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
            size_bytes: 5,
            node_version: "24.19.0".into(),
        };
        let mut cache = None;
        assert!(verify_archive_cached(&artifact, &archive, &mut cache).unwrap());
        assert!(!verify_archive_cached(&artifact, &archive, &mut cache).unwrap());
        for field in ["version", "platform", "arch", "archive", "nodeVersion"] {
            let mut changed = artifact.clone();
            match field {
                "version" => changed.version.push('x'),
                "platform" => changed.platform.push('x'),
                "arch" => changed.arch.push('x'),
                "archive" => changed.archive.push('x'),
                _ => changed.node_version.push('x'),
            }
            assert!(
                verify_archive_cached(&changed, &archive, &mut cache).unwrap(),
                "changed {field}"
            );
        }
        assert!(verify_archive_cached(&artifact, &archive, &mut cache).unwrap());
        fs::write(&archive, b"jello").unwrap();
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
        fs::File::options()
            .write(true)
            .open(&archive)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(future))
            .unwrap();
        assert!(verify_archive_cached(&artifact, &archive, &mut cache).is_err());
        fs::write(&archive, b"hello").unwrap();
        let mut changed = artifact.clone();
        changed.size_bytes += 1;
        assert!(verify_archive_cached(&changed, &archive, &mut cache).is_err());
        changed.size_bytes = artifact.size_bytes;
        changed.sha256 = "a".repeat(64);
        assert!(verify_archive_cached(&changed, &archive, &mut cache).is_err());
        fs::write(&archive, b"corrupt archive").unwrap();
        assert!(verify_archive_cached(&artifact, &archive, &mut cache).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn persisted_archive_stamp_skips_rehash_only_while_metadata_and_catalog_match() {
        let dir =
            std::env::temp_dir().join(format!("uniopc-archive-stamp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("runtime.tar.gz");
        let stamp = dir.join("verified-archive.json");
        fs::write(&archive, b"hello").unwrap();
        let artifact = RuntimeArtifact {
            version: OPENCLAW_ENGINE_VERSION.into(),
            platform: node_platform().into(),
            arch: node_arch().into(),
            archive: "runtime.tar.gz".into(),
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
            size_bytes: 5,
            node_version: "24.19.0".into(),
        };
        let fingerprint = archive_fingerprint(&artifact, &archive).unwrap();
        store_verified_archive_stamp_at(&stamp, &fingerprint).unwrap();
        assert!(persisted_archive_is_verified(&artifact, &archive, &stamp).unwrap());

        fs::write(&archive, b"jello").unwrap();
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
        fs::File::options()
            .write(true)
            .open(&archive)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(future))
            .unwrap();
        assert!(!persisted_archive_is_verified(&artifact, &archive, &stamp).unwrap());

        fs::write(&archive, b"hello").unwrap();
        let mut changed = artifact.clone();
        changed.node_version.push('x');
        assert!(!persisted_archive_is_verified(&changed, &archive, &stamp).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bundled_artifact_must_match_the_exact_engine_version() {
        assert!(bundled_artifact_matches_declared_version(
            OPENCLAW_ENGINE_VERSION
        ));
        assert!(!bundled_artifact_matches_declared_version("2026.7.1-2"));
        assert!(!bundled_artifact_matches_declared_version("2026.8.2"));
    }

    #[test]
    fn artifact_runtime_id_includes_the_verified_artifact_digest() {
        let mut artifact = RuntimeArtifact {
            version: OPENCLAW_ENGINE_VERSION.into(),
            platform: "darwin".into(),
            arch: "arm64".into(),
            archive: "runtime.tar.gz".into(),
            sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".into(),
            size_bytes: 1,
            node_version: "24.19.0".into(),
        };
        assert_eq!(
            artifact_runtime_id(&artifact).unwrap(),
            format!("{}-abcdef012345", OPENCLAW_ENGINE_VERSION),
        );
        artifact.sha256 = "not-a-digest".into();
        assert!(artifact_runtime_id(&artifact).is_err());
    }

    #[test]
    fn active_runtime_pointer_is_verified_before_reaching_the_fast_path() {
        assert!(active_runtime_version_is_verified(Some(
            OPENCLAW_ENGINE_VERSION
        )));
        assert!(active_runtime_version_is_verified(Some(
            "2026.8.1-abcdef012345"
        )));
        assert!(!active_runtime_version_is_verified(None));
    }

    #[test]
    fn node_platform_matches_current_os() {
        #[cfg(target_os = "macos")]
        assert_eq!(node_platform(), "darwin");
        #[cfg(target_os = "windows")]
        assert_eq!(node_platform(), "win32");
        #[cfg(target_os = "linux")]
        assert_eq!(node_platform(), "linux");
    }

    #[test]
    fn installed_version_reads_package_json() {
        let root = std::env::temp_dir().join(format!(
            "uniopc-bundled-runtime-test-{}",
            std::process::id()
        ));
        let package_dir = root
            .join("tools")
            .join("node-v22.22.2")
            .join("lib")
            .join("node_modules")
            .join("uniopc-engine");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(
            package_dir.join("package.json"),
            "{\"name\":\"openclaw\",\"version\":\"2026.6.11\"}",
        )
        .unwrap();
        assert_eq!(
            installed_openclaw_version(&root).as_deref(),
            Some("2026.6.11")
        );
        let _ = fs::remove_dir_all(&root);
    }
}
