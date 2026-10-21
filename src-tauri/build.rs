fn main() {
    println!("cargo:rerun-if-changed=Cargo.toml");
    if let Some(version) = uniopc_openclaw_version_from_manifest() {
        println!("cargo:rustc-env=IMAI_OPENCLAW_VERSION={version}");
    }
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=employee-icons/32x32.png");
    println!("cargo:rerun-if-changed=employee-icons/128x128.png");
    println!("cargo:rerun-if-changed=employee-icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=employee-icons/icon.icns");
    println!("cargo:rerun-if-changed=employee-icons/icon.ico");
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let attributes = if windows_msvc {
        // Apply the dependency to every linked executable, including libtests.
        // The linker owns the manifest so Tauri must not embed a second copy.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        tauri_build::Attributes::new()
    };
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}

fn uniopc_openclaw_version_from_manifest() -> Option<String> {
    let manifest = std::fs::read_to_string("Cargo.toml").ok()?;
    let mut in_uniopc_metadata = false;
    for raw_line in manifest.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_uniopc_metadata = line == "[package.metadata.uniopc]";
            continue;
        }
        if !in_uniopc_metadata {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "openclaw-version" {
            continue;
        }
        let value = value.trim().trim_matches('"').trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}
