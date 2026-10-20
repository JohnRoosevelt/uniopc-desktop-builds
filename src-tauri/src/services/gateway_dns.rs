//! Process-local Fake-IP recovery. Only the app-owned Gateway gets this preload.
use std::path::Path;

const PRELOAD: &str = include_str!("gateway_dns.cjs");

pub fn command(program: String, args: Vec<String>) -> Result<(String, Vec<String>), String> {
    // Windows already resolves to node.exe; Unix normally resolves a shell
    // shim. Launch the same bundled entry directly to pass Node flags without
    // NODE_OPTIONS leaking into other subprocesses.
    let (node, mut entry_args) = if cfg!(windows) {
        if Path::new(&program).file_name().and_then(|s| s.to_str()) != Some("node.exe") {
            return Ok((program, args));
        }
        (program, args)
    } else {
        let bin = super::uniopc_runtime_paths::runtime_node_bin_dir()?;
        let node = bin.join("node");
        let entry = bin
            .parent()
            .ok_or("Invalid bundled Node directory")?
            .join("lib/node_modules/uniopc-engine/dist/entry.js");
        if !node.is_file() || !entry.is_file() {
            return Err("内置 Gateway DNS 兼容层找不到匹配的 Node/引擎入口。".to_string());
        }
        let mut entry_args = vec![entry.to_string_lossy().to_string()];
        entry_args.extend(args);
        (node.to_string_lossy().to_string(), entry_args)
    };
    let dir = super::uniopc_runtime_paths::uniopc_data_dir()?.join("network");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 Gateway DNS 兼容层目录失败: {e}"))?;
    let path = dir.join("gateway-dns.cjs");
    std::fs::write(&path, PRELOAD).map_err(|e| format!("写入 Gateway DNS 兼容层失败: {e}"))?;
    let mut result = vec!["--require".to_string(), path.to_string_lossy().to_string()];
    result.append(&mut entry_args);
    Ok((node, result))
}
