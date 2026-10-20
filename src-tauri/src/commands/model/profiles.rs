//! Uniopc 引擎 profile command boundary.
//!
//! Profile ownership includes profile provisioning, profile status checks,
//! per-profile Gateway ports, and managed member profile initialization.

use super::{
    OpenClawProfileProvisionRequest, OpenClawProfileProvisionResult, OpenClawProfileStatusRequest,
    OpenClawProfileStatusResult,
};
use tauri::AppHandle;

pub(crate) async fn openclaw_profile_provision(
    app: AppHandle,
    input: OpenClawProfileProvisionRequest,
) -> Result<OpenClawProfileProvisionResult, String> {
    super::openclaw_profile_provision_impl(app, input).await
}

#[tauri::command]
pub async fn openclaw_profile_status(
    app: AppHandle,
    input: OpenClawProfileStatusRequest,
) -> Result<OpenClawProfileStatusResult, String> {
    super::openclaw_profile_status_impl(app, input).await
}

/// Wipe one account's local engine data (`state/<key>`). `profile` omitted →
/// the active account. Stops + forgets the account first if it's the live one.
#[tauri::command]
pub async fn openclaw_reset_profile_data(
    app: AppHandle,
    profile: Option<String>,
) -> Result<String, String> {
    super::openclaw_reset_profile_data_impl(app, profile).await
}

/// Log out of the active account: stop its engine and clear the active marker
/// (data preserved on disk).
#[tauri::command]
pub async fn openclaw_logout_active_profile(app: AppHandle) -> Result<(), String> {
    super::openclaw_logout_active_profile_impl(app).await
}
