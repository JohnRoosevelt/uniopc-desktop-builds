use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::local_documents::{
    LocalDocument, LocalDocumentCreate, LocalDocumentError, LocalDocumentStore,
    LocalDocumentSummary, LocalDocumentUpdate,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalDocumentsListRequest {
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalDocumentGetRequest {
    #[serde(default)]
    pub profile: Option<String>,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalDocumentCreateRequest {
    #[serde(default)]
    pub profile: Option<String>,
    pub title: String,
    pub category: String,
    pub blocksuite_body: String,
    pub markdown_projection: String,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalDocumentUpdateRequest {
    #[serde(default)]
    pub profile: Option<String>,
    pub id: String,
    pub title: String,
    pub category: String,
    pub blocksuite_body: String,
    pub markdown_projection: String,
    #[serde(default)]
    pub metadata: Value,
    pub base_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalDocumentArchiveRequest {
    #[serde(default)]
    pub profile: Option<String>,
    pub id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDocumentsListResponse {
    pub documents: Vec<LocalDocumentSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDocumentResponse {
    pub document: LocalDocument,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDocumentCommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

fn command_error(error: LocalDocumentError) -> LocalDocumentCommandError {
    match error {
        LocalDocumentError::DocumentConflict(conflict) => LocalDocumentCommandError {
            code: "document_conflict".to_string(),
            message: "The document changed since it was opened.".to_string(),
            details: serde_json::to_value(conflict).ok(),
        },
        LocalDocumentError::InvalidInput(message) => LocalDocumentCommandError {
            code: "invalid_input".to_string(),
            message,
            details: None,
        },
        LocalDocumentError::NotFound => LocalDocumentCommandError {
            code: "document_not_found".to_string(),
            message: "The document was not found.".to_string(),
            details: None,
        },
        // Storage errors can include native credential-store or database
        // diagnostics. Keep those details inside Rust so IPC never exposes a
        // database location or credential-store identifier.
        LocalDocumentError::Storage(_) => LocalDocumentCommandError {
            code: "local_documents_unavailable".to_string(),
            message: "Local documents are unavailable.".to_string(),
            details: None,
        },
    }
}

fn join_error(error: tauri::Error) -> LocalDocumentCommandError {
    let _ = error;
    LocalDocumentCommandError {
        code: "local_documents_unavailable".to_string(),
        message: "Local documents are unavailable.".to_string(),
        details: None,
    }
}

#[tauri::command]
pub async fn local_documents_list(
    input: LocalDocumentsListRequest,
) -> Result<LocalDocumentsListResponse, LocalDocumentCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = LocalDocumentStore::new(input.profile.as_deref()).map_err(command_error)?;
        let documents = store
            .list(input.category.as_deref())
            .map_err(command_error)?;
        Ok(LocalDocumentsListResponse { documents })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn local_document_get(
    input: LocalDocumentGetRequest,
) -> Result<LocalDocumentResponse, LocalDocumentCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = LocalDocumentStore::new(input.profile.as_deref()).map_err(command_error)?;
        let document = store.get(&input.id).map_err(command_error)?;
        Ok(LocalDocumentResponse { document })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn local_document_create(
    input: LocalDocumentCreateRequest,
) -> Result<LocalDocumentResponse, LocalDocumentCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = LocalDocumentStore::new(input.profile.as_deref()).map_err(command_error)?;
        let document = store
            .create(LocalDocumentCreate {
                title: input.title,
                category: input.category,
                blocksuite_body: input.blocksuite_body,
                markdown_projection: input.markdown_projection,
                metadata: input.metadata,
            })
            .map_err(command_error)?;
        Ok(LocalDocumentResponse { document })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn local_document_update(
    input: LocalDocumentUpdateRequest,
) -> Result<LocalDocumentResponse, LocalDocumentCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = LocalDocumentStore::new(input.profile.as_deref()).map_err(command_error)?;
        let document = store
            .update(LocalDocumentUpdate {
                id: input.id,
                title: input.title,
                category: input.category,
                blocksuite_body: input.blocksuite_body,
                markdown_projection: input.markdown_projection,
                metadata: input.metadata,
                base_hash: input.base_hash,
            })
            .map_err(command_error)?;
        Ok(LocalDocumentResponse { document })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn local_document_archive(
    input: LocalDocumentArchiveRequest,
) -> Result<LocalDocumentResponse, LocalDocumentCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = LocalDocumentStore::new(input.profile.as_deref()).map_err(command_error)?;
        let document = store.archive(&input.id).map_err(command_error)?;
        Ok(LocalDocumentResponse { document })
    })
    .await
    .map_err(join_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::local_documents::LocalDocumentConflict;

    #[test]
    fn update_command_returns_conflict_for_stale_hash() {
        let error = command_error(LocalDocumentError::DocumentConflict(
            LocalDocumentConflict {
                id: "doc-1".to_string(),
                title: "Current title".to_string(),
                current_hash: "hash-current".to_string(),
                updated_at: "2026-08-09T00:00:00.000Z".to_string(),
            },
        ));

        assert_eq!(error.code, "document_conflict");
        assert_eq!(error.details.unwrap()["currentHash"], "hash-current");
    }

    #[test]
    fn update_request_deserializes_camel_case_fields() {
        let request: LocalDocumentUpdateRequest = serde_json::from_value(serde_json::json!({
            "id": "doc-1",
            "title": "Updated",
            "category": "research",
            "blocksuiteBody": "body",
            "markdownProjection": "# Updated",
            "metadata": {},
            "baseHash": "hash-current"
        }))
        .unwrap();

        assert_eq!(request.blocksuite_body, "body");
        assert_eq!(request.base_hash, "hash-current");
    }
}
