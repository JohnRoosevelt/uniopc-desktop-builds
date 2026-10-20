use crate::services::mac_permissions::{self, MacPermissionStatus};

#[tauri::command]
pub async fn mac_permissions_status() -> Result<MacPermissionStatus, String> {
    mac_permissions::status().await
}

#[tauri::command]
pub async fn mac_permissions_request(capability: String) -> Result<MacPermissionStatus, String> {
    mac_permissions::request(&capability).await?;
    mac_permissions::status().await
}
