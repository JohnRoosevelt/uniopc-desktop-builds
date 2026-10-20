use super::{
    ConversationBridgeStatus, GatewayConnectAttemptResult, GatewayConnectPreview,
    GatewayPairingApprovalResult, GatewayPairingStatus, OpenClawProfilePairingRequest,
    OpenClawProfileRedeemRemoteSetupRequest, OpenClawProfileRedeemRemoteSetupResult,
    OpenClawProfileRemoteSetupRequest, OpenClawProfileRemoteSetupResult,
};
use tauri::AppHandle;

#[tauri::command]
pub async fn conversation_bridge_status(
    app: AppHandle,
    profile: Option<String>,
) -> Result<ConversationBridgeStatus, String> {
    super::conversation_bridge_status_impl(app, profile).await
}

#[tauri::command]
pub async fn conversation_prepare_gateway_connect_preview(
    app: AppHandle,
    profile: Option<String>,
) -> Result<GatewayConnectPreview, String> {
    super::conversation_prepare_gateway_connect_preview_impl(app, profile).await
}

#[tauri::command]
pub async fn conversation_attempt_gateway_connect(
    app: AppHandle,
    profile: Option<String>,
) -> Result<GatewayConnectAttemptResult, String> {
    super::conversation_attempt_gateway_connect_impl(app, profile).await
}

#[tauri::command]
pub async fn conversation_gateway_pairing_status(
    app: AppHandle,
) -> Result<GatewayPairingStatus, String> {
    super::conversation_gateway_pairing_status_impl(app).await
}

#[tauri::command]
pub async fn openclaw_profile_remote_setup_code(
    input: OpenClawProfileRemoteSetupRequest,
) -> Result<OpenClawProfileRemoteSetupResult, String> {
    super::openclaw_profile_remote_setup_code_impl(input).await
}

#[tauri::command]
pub async fn openclaw_profile_pairing_status(
    input: OpenClawProfilePairingRequest,
) -> Result<GatewayPairingStatus, String> {
    super::openclaw_profile_pairing_status_impl(input).await
}

#[tauri::command]
pub async fn openclaw_profile_approve_latest_pairing(
    app: AppHandle,
    input: OpenClawProfilePairingRequest,
) -> Result<GatewayPairingApprovalResult, String> {
    super::openclaw_profile_approve_latest_pairing_impl(app, input).await
}

#[tauri::command]
pub async fn openclaw_profile_redeem_remote_setup(
    app: AppHandle,
    input: OpenClawProfileRedeemRemoteSetupRequest,
) -> Result<OpenClawProfileRedeemRemoteSetupResult, String> {
    super::openclaw_profile_redeem_remote_setup_impl(app, input).await
}

#[tauri::command]
pub async fn conversation_gateway_approve_latest_pairing(
    app: AppHandle,
) -> Result<GatewayPairingApprovalResult, String> {
    super::conversation_gateway_approve_latest_pairing_impl(app).await
}
