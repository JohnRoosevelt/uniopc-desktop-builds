pub const LEGACY_DEFAULT_OPENCLAW_PROFILE: &str = "default";
pub const BUSINESS_PROJECT_RUNTIME_MODE: &str = "business";
pub const DEFAULT_BROWSER_PROFILE: &str = "openclaw";

pub fn normalize_profile_key(profile: Option<&str>) -> String {
    profile
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("")
        .to_string()
}

pub fn require_profile_key(profile: Option<&str>) -> Result<String, String> {
    let profile = normalize_profile_key(profile);
    if profile.is_empty() {
        return Err("Uniopc 引擎 profile 不能为空，请先完成工作空间 profile 初始化。".to_string());
    }
    Ok(profile)
}

pub fn is_legacy_default_profile(profile: &str) -> bool {
    profile.trim().is_empty() || profile.trim() == LEGACY_DEFAULT_OPENCLAW_PROFILE
}
