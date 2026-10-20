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
    tauri_build::build()
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
