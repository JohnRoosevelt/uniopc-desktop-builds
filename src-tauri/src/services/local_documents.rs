//! Per-profile storage for personal documents.
//!
//! New databases are ordinary SQLite files. The legacy SQLCipher format is
//! unlocked through the OS credential store exactly once to migrate it to the
//! plain format; normal document access never touches the credential store.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rand::RngCore;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::services::uniopc_runtime_paths::{resolve_profile_key, state_v8_base_dir};

const DATABASE_DIRECTORY: &str = "documents";
const DATABASE_FILE: &str = "documents.db";
const KEYRING_SERVICE: &str = "com.uniopc.desktop.local-documents";
const DOCUMENT_KEY_BYTES: usize = 32;
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

static KEYRING_LOCK: Mutex<()> = Mutex::new(());

trait DocumentKeyProvider: Send + Sync {
    fn key_for_profile(&self, profile: &str) -> Result<Zeroizing<Vec<u8>>, String>;
}

struct OsCredentialDocumentKeyProvider;

impl DocumentKeyProvider for OsCredentialDocumentKeyProvider {
    fn key_for_profile(&self, profile: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        let _guard = KEYRING_LOCK
            .lock()
            .map_err(|_| "document credential-store lock poisoned".to_string())?;
        let entry = keyring::Entry::new(KEYRING_SERVICE, profile)
            .map_err(|err| format!("open document credential-store entry: {err}"))?;

        match entry.get_secret() {
            Ok(key) => validate_document_key(key),
            Err(keyring::Error::NoEntry) => {
                let mut key = Zeroizing::new(vec![0_u8; DOCUMENT_KEY_BYTES]);
                rand::rngs::OsRng.fill_bytes(&mut key);
                entry
                    .set_secret(&key)
                    .map_err(|err| format!("write document credential-store entry: {err}"))?;
                Ok(key)
            }
            Err(err) => Err(format!("read document credential-store entry: {err}")),
        }
    }
}

fn validate_document_key(key: Vec<u8>) -> Result<Zeroizing<Vec<u8>>, String> {
    let key = Zeroizing::new(key);
    if key.len() != DOCUMENT_KEY_BYTES {
        return Err("document credential-store key has invalid length".to_string());
    }
    Ok(key)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDocumentCreate {
    pub title: String,
    pub category: String,
    pub blocksuite_body: String,
    pub markdown_projection: String,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDocumentUpdate {
    pub id: String,
    pub title: String,
    pub category: String,
    pub blocksuite_body: String,
    pub markdown_projection: String,
    #[serde(default)]
    pub metadata: Value,
    pub base_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDocument {
    pub id: String,
    pub title: String,
    pub category: String,
    pub blocksuite_body: String,
    pub markdown_projection: String,
    pub content_hash: String,
    pub status: String,
    pub metadata: Value,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDocumentSummary {
    pub id: String,
    pub title: String,
    pub category: String,
    pub markdown_projection: String,
    pub content_hash: String,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDocumentConflict {
    pub id: String,
    pub title: String,
    pub current_hash: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "code", content = "details", rename_all = "snake_case")]
pub enum LocalDocumentError {
    DocumentConflict(LocalDocumentConflict),
    InvalidInput(String),
    NotFound,
    Storage(String),
}

impl std::fmt::Display for LocalDocumentError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DocumentConflict(_) => formatter.write_str("document conflict"),
            Self::InvalidInput(message) | Self::Storage(message) => formatter.write_str(message),
            Self::NotFound => formatter.write_str("document not found"),
        }
    }
}

impl std::error::Error for LocalDocumentError {}

impl From<rusqlite::Error> for LocalDocumentError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(format!("local document database error: {error}"))
    }
}

pub struct LocalDocumentStore {
    profile: String,
    database_path: PathBuf,
    legacy_key_provider: Arc<dyn DocumentKeyProvider>,
}

impl LocalDocumentStore {
    pub fn new(profile: Option<&str>) -> Result<Self, LocalDocumentError> {
        let profile_key = resolve_profile_key(profile);
        let state_base = state_v8_base_dir()
            .map_err(|err| LocalDocumentError::Storage(format!("resolve document state: {err}")))?;
        Ok(Self::from_resolved_profile(
            profile_key,
            state_base,
            Arc::new(OsCredentialDocumentKeyProvider),
        ))
    }

    fn from_resolved_profile(
        profile: String,
        state_base: PathBuf,
        legacy_key_provider: Arc<dyn DocumentKeyProvider>,
    ) -> Self {
        let database_path = state_base
            .join(&profile)
            .join(DATABASE_DIRECTORY)
            .join(DATABASE_FILE);
        Self {
            profile,
            database_path,
            legacy_key_provider,
        }
    }

    #[cfg(test)]
    fn with_storage(
        profile: String,
        database_path: PathBuf,
        legacy_key_provider: Arc<dyn DocumentKeyProvider>,
    ) -> Self {
        Self {
            profile,
            database_path,
            legacy_key_provider,
        }
    }

    fn connection(&self) -> Result<Connection, LocalDocumentError> {
        let parent = self.database_path.parent().ok_or_else(|| {
            LocalDocumentError::Storage("document database has no parent directory".to_string())
        })?;
        std::fs::create_dir_all(parent).map_err(|err| {
            LocalDocumentError::Storage(format!("create document database directory: {err}"))
        })?;

        self.ensure_database_ready()?;
        let mut connection = Connection::open(&self.database_path)?;
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;
        migrate(&mut connection)?;
        Ok(connection)
    }

    fn read_connection(&self) -> Result<Option<Connection>, LocalDocumentError> {
        if !self.database_path.exists() {
            return Ok(None);
        }

        self.ensure_database_ready()?;
        let connection = Connection::open_with_flags(
            &self.database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        Ok(Some(connection))
    }

    fn ensure_database_ready(&self) -> Result<(), LocalDocumentError> {
        if !self.database_path.exists() || has_sqlite_header(&self.database_path)? {
            return Ok(());
        }
        migrate_legacy_encrypted_database(
            &self.profile,
            &self.database_path,
            self.legacy_key_provider.as_ref(),
        )
    }

    pub fn list(
        &self,
        category: Option<&str>,
    ) -> Result<Vec<LocalDocumentSummary>, LocalDocumentError> {
        let Some(connection) = self.read_connection()? else {
            return Ok(Vec::new());
        };
        let normalized_category = category.map(normalize_category);
        let mut statement = connection.prepare(
            r#"SELECT id, title, category, markdown_projection, content_hash, status,
                      current_version, created_at, updated_at
               FROM documents
               WHERE status = 'active' AND (?1 IS NULL OR category = ?1)
               ORDER BY updated_at DESC, id ASC"#,
        )?;
        let rows = statement.query_map(params![normalized_category], summary_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn create(&self, input: LocalDocumentCreate) -> Result<LocalDocument, LocalDocumentError> {
        validate_input(&input.title, &input.blocksuite_body)?;
        let mut connection = self.connection()?;
        let id = uuid::Uuid::new_v4().to_string();
        let title = input.title.trim().to_string();
        let category = normalize_category(&input.category);
        let content_hash = content_hash(&input.blocksuite_body);
        let metadata = serde_json::to_string(&input.metadata)
            .map_err(|err| LocalDocumentError::InvalidInput(format!("invalid metadata: {err}")))?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        transaction.execute(
            r#"INSERT INTO documents (
                  id, title, category, blocksuite_body, markdown_projection, content_hash,
                  status, metadata_json, current_version, created_at, updated_at
               ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, 1, ?8, ?8)"#,
            params![
                id,
                title,
                category,
                input.blocksuite_body,
                input.markdown_projection,
                content_hash,
                metadata,
                now,
            ],
        )?;
        transaction.execute(
            r#"INSERT INTO document_versions (
                  document_id, version, title, category, blocksuite_body,
                  markdown_projection, content_hash, metadata_json, created_at
               ) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
            params![
                id,
                title,
                category,
                input.blocksuite_body,
                input.markdown_projection,
                content_hash,
                metadata,
                now,
            ],
        )?;
        let document = query_document(&transaction, &id)?;
        transaction.commit()?;
        Ok(document)
    }

    pub fn get(&self, id: &str) -> Result<LocalDocument, LocalDocumentError> {
        let Some(connection) = self.read_connection()? else {
            return Err(LocalDocumentError::NotFound);
        };
        query_document(&connection, id)
    }

    pub fn update(&self, input: LocalDocumentUpdate) -> Result<LocalDocument, LocalDocumentError> {
        validate_id(&input.id)?;
        validate_input(&input.title, &input.blocksuite_body)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = query_document(&transaction, &input.id)?;
        if input.base_hash.trim() != current.content_hash {
            return Err(LocalDocumentError::DocumentConflict(
                LocalDocumentConflict {
                    id: current.id,
                    title: current.title,
                    current_hash: current.content_hash,
                    updated_at: current.updated_at,
                },
            ));
        }

        let title = input.title.trim().to_string();
        let category = normalize_category(&input.category);
        let content_hash = content_hash(&input.blocksuite_body);
        let metadata = serde_json::to_string(&input.metadata)
            .map_err(|err| LocalDocumentError::InvalidInput(format!("invalid metadata: {err}")))?;
        let version = current.version + 1;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        transaction.execute(
            r#"UPDATE documents
               SET title = ?2, category = ?3, blocksuite_body = ?4,
                   markdown_projection = ?5, content_hash = ?6,
                   metadata_json = ?7, current_version = ?8, updated_at = ?9
               WHERE id = ?1"#,
            params![
                input.id,
                title,
                category,
                input.blocksuite_body,
                input.markdown_projection,
                content_hash,
                metadata,
                version,
                now,
            ],
        )?;
        transaction.execute(
            r#"INSERT INTO document_versions (
                  document_id, version, title, category, blocksuite_body,
                  markdown_projection, content_hash, metadata_json, created_at
               ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
            params![
                input.id,
                version,
                title,
                category,
                input.blocksuite_body,
                input.markdown_projection,
                content_hash,
                metadata,
                now,
            ],
        )?;
        let document = query_document(&transaction, &input.id)?;
        transaction.commit()?;
        Ok(document)
    }

    pub fn archive(&self, id: &str) -> Result<LocalDocument, LocalDocumentError> {
        validate_id(id)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        query_document(&transaction, id)?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        transaction.execute(
            "UPDATE documents SET status = 'archived', updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        let document = query_document(&transaction, id)?;
        transaction.commit()?;
        Ok(document)
    }
}

fn migrate(connection: &mut Connection) -> Result<(), LocalDocumentError> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        r#"CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              applied_at TEXT NOT NULL
           );
           CREATE TABLE IF NOT EXISTS documents (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              category TEXT NOT NULL,
              blocksuite_body TEXT NOT NULL,
              markdown_projection TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
              metadata_json TEXT NOT NULL,
              current_version INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
           );
           CREATE TABLE IF NOT EXISTS document_versions (
              document_id TEXT NOT NULL REFERENCES documents(id),
              version INTEGER NOT NULL,
              title TEXT NOT NULL,
              category TEXT NOT NULL,
              blocksuite_body TEXT NOT NULL,
              markdown_projection TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY (document_id, version)
           );
           CREATE INDEX IF NOT EXISTS idx_documents_status_updated_at
              ON documents(status, updated_at DESC);"#,
    )?;
    transaction.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?1)",
        params![chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)],
    )?;
    transaction.commit()?;
    Ok(())
}

fn has_sqlite_header(path: &std::path::Path) -> Result<bool, LocalDocumentError> {
    let mut header = [0_u8; SQLITE_HEADER.len()];
    let mut file = std::fs::File::open(path).map_err(|err| {
        LocalDocumentError::Storage(format!("open local document database: {err}"))
    })?;
    use std::io::Read;
    match file.read_exact(&mut header) {
        Ok(()) => Ok(header == *SQLITE_HEADER),
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(err) => Err(LocalDocumentError::Storage(format!(
            "read local document database header: {err}"
        ))),
    }
}

fn migrate_legacy_encrypted_database(
    profile: &str,
    database_path: &std::path::Path,
    key_provider: &dyn DocumentKeyProvider,
) -> Result<(), LocalDocumentError> {
    let key = key_provider
        .key_for_profile(profile)
        .map_err(LocalDocumentError::Storage)?;
    let source = Connection::open(database_path)?;
    let key_hex = Zeroizing::new(hex::encode(key.as_slice()));
    let key_pragma = Zeroizing::new(format!("PRAGMA key = \"x'{}'\";", key_hex.as_str()));
    source.execute_batch(key_pragma.as_str()).map_err(|_| {
        LocalDocumentError::Storage("unlock local document database failed".to_string())
    })?;
    source
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|_| {
            LocalDocumentError::Storage("unlock local document database failed".to_string())
        })?;

    let temporary_path =
        database_path.with_extension(format!("migration-{}.tmp", uuid::Uuid::new_v4()));
    let backup_path = database_path.with_file_name("documents.encrypted.legacy.db");
    let result = (|| -> Result<(), LocalDocumentError> {
        let mut destination = Connection::open(&temporary_path)?;
        destination.execute_batch("PRAGMA foreign_keys = ON;")?;
        migrate(&mut destination)?;
        copy_legacy_documents(&source, &mut destination)?;
        drop(destination);
        drop(source);

        let verification = Connection::open(&temporary_path)?;
        verification
            .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|err| {
                LocalDocumentError::Storage(format!("validate migrated documents: {err}"))
            })?;
        drop(verification);

        if backup_path.exists() {
            return Err(LocalDocumentError::Storage(
                "legacy encrypted document backup already exists".to_string(),
            ));
        }
        std::fs::rename(database_path, &backup_path).map_err(|err| {
            LocalDocumentError::Storage(format!("backup encrypted local documents: {err}"))
        })?;
        std::fs::rename(&temporary_path, database_path).map_err(|err| {
            let _ = std::fs::rename(&backup_path, database_path);
            LocalDocumentError::Storage(format!("promote migrated local documents: {err}"))
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

fn copy_legacy_documents(
    source: &Connection,
    destination: &mut Connection,
) -> Result<(), LocalDocumentError> {
    let transaction = destination.transaction()?;
    for table in ["schema_migrations", "documents", "document_versions"] {
        let mut statement = source.prepare(&format!("SELECT * FROM {table}"))?;
        let column_count = statement.column_count();
        let placeholders = std::iter::repeat_n("?", column_count)
            .collect::<Vec<_>>()
            .join(", ");
        let columns = (0..column_count)
            .map(|index| statement.column_name(index).unwrap().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let insert = format!("INSERT OR IGNORE INTO {table} ({columns}) VALUES ({placeholders})");
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let values = (0..column_count)
                .map(|index| {
                    row.get_ref(index).and_then(|value| {
                        rusqlite::types::Value::try_from(value).map_err(Into::into)
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            transaction.execute(&insert, rusqlite::params_from_iter(values))?;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn validate_input(title: &str, blocksuite_body: &str) -> Result<(), LocalDocumentError> {
    if title.trim().is_empty() {
        return Err(LocalDocumentError::InvalidInput(
            "missing document title".to_string(),
        ));
    }
    if blocksuite_body.len() > 16 * 1024 * 1024 {
        return Err(LocalDocumentError::InvalidInput(format!(
            "document body too large: {} bytes (max {})",
            blocksuite_body.len(),
            16 * 1024 * 1024
        )));
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), LocalDocumentError> {
    if id.trim().is_empty() {
        return Err(LocalDocumentError::InvalidInput(
            "missing document id".to_string(),
        ));
    }
    Ok(())
}

fn normalize_category(category: &str) -> String {
    match category.trim() {
        "product" | "technical" | "testing" | "marketing" | "operations" | "meeting"
        | "customer" | "work_report" | "research" => category.trim().to_string(),
        _ => "other".to_string(),
    }
}

fn content_hash(body: &str) -> String {
    hex::encode(Sha256::digest(body.as_bytes()))
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalDocumentSummary> {
    Ok(LocalDocumentSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        category: row.get(2)?,
        markdown_projection: row.get(3)?,
        content_hash: row.get(4)?,
        status: row.get(5)?,
        version: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn document_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalDocument> {
    let metadata_json: String = row.get(7)?;
    let metadata = serde_json::from_str(&metadata_json).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(err))
    })?;
    Ok(LocalDocument {
        id: row.get(0)?,
        title: row.get(1)?,
        category: row.get(2)?,
        blocksuite_body: row.get(3)?,
        markdown_projection: row.get(4)?,
        content_hash: row.get(5)?,
        status: row.get(6)?,
        metadata,
        version: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn query_document(connection: &Connection, id: &str) -> Result<LocalDocument, LocalDocumentError> {
    connection
        .query_row(
            r#"SELECT id, title, category, blocksuite_body, markdown_projection,
                      content_hash, status, metadata_json, current_version,
                      created_at, updated_at
               FROM documents WHERE id = ?1"#,
            params![id],
            document_from_row,
        )
        .optional()?
        .ok_or(LocalDocumentError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RecordingKeyProvider {
        profiles: Arc<Mutex<Vec<String>>>,
    }

    impl DocumentKeyProvider for RecordingKeyProvider {
        fn key_for_profile(&self, profile: &str) -> Result<Zeroizing<Vec<u8>>, String> {
            self.profiles.lock().unwrap().push(profile.to_string());
            Ok(Zeroizing::new(vec![7_u8; DOCUMENT_KEY_BYTES]))
        }
    }

    struct CountingKeyProvider {
        calls: Arc<Mutex<usize>>,
    }

    impl DocumentKeyProvider for CountingKeyProvider {
        fn key_for_profile(&self, profile: &str) -> Result<Zeroizing<Vec<u8>>, String> {
            *self.calls.lock().unwrap() += 1;
            let mut key = vec![0_u8; DOCUMENT_KEY_BYTES];
            let digest = Sha256::digest(profile.as_bytes());
            key.copy_from_slice(&digest);
            Ok(Zeroizing::new(key))
        }
    }

    struct RejectingKeyProvider;

    impl DocumentKeyProvider for RejectingKeyProvider {
        fn key_for_profile(&self, _: &str) -> Result<Zeroizing<Vec<u8>>, String> {
            Err("credential store must not be used".to_string())
        }
    }

    struct MutableKeyProvider {
        key: Arc<Mutex<Vec<u8>>>,
    }

    impl DocumentKeyProvider for MutableKeyProvider {
        fn key_for_profile(&self, _: &str) -> Result<Zeroizing<Vec<u8>>, String> {
            Ok(Zeroizing::new(self.key.lock().unwrap().clone()))
        }
    }

    struct TestStore {
        store: LocalDocumentStore,
        database_path: PathBuf,
        key_provider_calls: Arc<Mutex<usize>>,
    }

    impl TestStore {
        fn new(profile: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "uniopc-local-documents-test-{}-profile-isolation",
                std::process::id()
            ));
            if profile == "alpha" {
                std::fs::remove_dir_all(&root).ok();
            }
            let database_path = root
                .join(profile)
                .join(DATABASE_DIRECTORY)
                .join(DATABASE_FILE);
            let key_provider_calls = Arc::new(Mutex::new(0));
            Self {
                store: LocalDocumentStore::with_storage(
                    profile.to_string(),
                    database_path.clone(),
                    Arc::new(CountingKeyProvider {
                        calls: Arc::clone(&key_provider_calls),
                    }),
                ),
                database_path,
                key_provider_calls,
            }
        }

        fn create(&self, input: LocalDocumentCreate) -> Result<LocalDocument, LocalDocumentError> {
            self.store.create(input)
        }

        fn isolated(test_name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "uniopc-local-documents-test-{}-{test_name}",
                std::process::id()
            ));
            std::fs::remove_dir_all(&root).ok();
            let profile = format!("test-{test_name}");
            let database_path = root.join(DATABASE_DIRECTORY).join(DATABASE_FILE);
            let key_provider_calls = Arc::new(Mutex::new(0));
            Self {
                store: LocalDocumentStore::with_storage(
                    profile.clone(),
                    database_path.clone(),
                    Arc::new(CountingKeyProvider {
                        calls: Arc::clone(&key_provider_calls),
                    }),
                ),
                database_path,
                key_provider_calls,
            }
        }

        fn list(
            &self,
            category: Option<&str>,
        ) -> Result<Vec<LocalDocumentSummary>, LocalDocumentError> {
            self.store.list(category)
        }

        fn database_path(&self) -> &std::path::Path {
            &self.database_path
        }

        fn key_provider_calls(&self) -> usize {
            *self.key_provider_calls.lock().unwrap()
        }

        fn reopen_without_key(&self) -> LocalDocumentStore {
            LocalDocumentStore::with_storage(
                self.store.profile.clone(),
                self.database_path.clone(),
                Arc::new(RejectingKeyProvider),
            )
        }

        fn version_rows(&self) -> Vec<(i64, String)> {
            let connection = self.store.connection().unwrap();
            let mut statement = connection
                .prepare(
                    "SELECT version, blocksuite_body FROM document_versions ORDER BY version ASC",
                )
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        }

        fn encrypted_backup_path(&self) -> PathBuf {
            self.database_path
                .with_file_name("documents.encrypted.legacy.db")
        }
    }

    fn sample_create(body: &str) -> LocalDocumentCreate {
        LocalDocumentCreate {
            title: "Sample".to_string(),
            category: "technical".to_string(),
            blocksuite_body: body.to_string(),
            markdown_projection: "# Sample".to_string(),
            metadata: serde_json::json!({"body_format": "blocksuite_crdt"}),
        }
    }

    #[test]
    fn document_data_is_profile_isolated_in_plain_sqlite_files() {
        let alpha = TestStore::new("alpha");
        let beta = TestStore::new("beta");
        alpha.create(sample_create("alpha note")).unwrap();
        assert!(beta.list(None).unwrap().is_empty());
        assert!(
            String::from_utf8_lossy(&std::fs::read(alpha.database_path()).unwrap())
                .contains("alpha note")
        );
    }

    #[test]
    fn new_document_store_never_requests_a_credential_store_key() {
        let store = TestStore::isolated("plain-store");

        store.create(sample_create("plain document")).unwrap();

        assert_eq!(store.key_provider_calls(), 0);
        assert_eq!(
            &std::fs::read(store.database_path()).unwrap()[..16],
            b"SQLite format 3\0"
        );
    }

    #[test]
    fn plain_store_reopens_without_a_legacy_key() {
        let store = TestStore::isolated("plain-reopen");
        let saved = store.create(sample_create("reopen me")).unwrap();

        assert_eq!(
            store.reopen_without_key().get(&saved.id).unwrap().title,
            "Sample"
        );
    }

    #[test]
    fn list_does_not_require_a_write_lock_after_schema_is_initialized() {
        let store = TestStore::isolated("list-with-competing-writer");
        store.create(sample_create("available while a save is in progress")).unwrap();

        let writer = Connection::open(store.database_path()).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE;").unwrap();

        let documents = store.list(None).unwrap();

        writer.execute_batch("ROLLBACK;").unwrap();
        assert_eq!(documents.len(), 1);
    }

    fn legacy_encrypted_store(
        test_name: &str,
        body: &str,
    ) -> (TestStore, String, Arc<Mutex<Vec<u8>>>) {
        let root = std::env::temp_dir().join(format!(
            "uniopc-local-documents-test-{}-{test_name}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        let database_path = root.join(DATABASE_FILE);
        let key = Arc::new(Mutex::new(vec![3_u8; DOCUMENT_KEY_BYTES]));
        let mut encrypted = Connection::open(&database_path).unwrap();
        let key_hex = hex::encode(key.lock().unwrap().as_slice());
        encrypted
            .execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))
            .unwrap();
        migrate(&mut encrypted).unwrap();
        let id = "legacy-document-id".to_string();
        encrypted
            .execute(
                r#"INSERT INTO documents (
                  id, title, category, blocksuite_body, markdown_projection, content_hash,
                  status, metadata_json, current_version, created_at, updated_at
               ) VALUES (?1, 'Legacy', 'technical', ?2, '# Legacy', ?3, 'active', '{}', 1,
                         '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')"#,
                params![id, body, content_hash(body)],
            )
            .unwrap();
        encrypted
            .execute(
                r#"INSERT INTO document_versions (
                  document_id, version, title, category, blocksuite_body,
                  markdown_projection, content_hash, metadata_json, created_at
               ) VALUES (?1, 1, 'Legacy', 'technical', ?2, '# Legacy', ?3, '{}',
                         '2026-08-13T00:00:00.000Z')"#,
                params![id, body, content_hash(body)],
            )
            .unwrap();
        drop(encrypted);

        (
            TestStore {
                store: LocalDocumentStore::with_storage(
                    format!("test-{test_name}"),
                    database_path.clone(),
                    Arc::new(MutableKeyProvider {
                        key: Arc::clone(&key),
                    }),
                ),
                database_path,
                key_provider_calls: Arc::new(Mutex::new(0)),
            },
            id,
            key,
        )
    }

    #[test]
    fn encrypted_legacy_store_migrates_documents_and_versions_to_plain_sqlite() {
        let (store, document_id, _) = legacy_encrypted_store("legacy-migration", "legacy body");

        let document = store.store.get(&document_id).unwrap();

        assert_eq!(document.blocksuite_body, "legacy body");
        assert_eq!(store.version_rows(), vec![(1, "legacy body".to_string())]);
        assert_eq!(
            &std::fs::read(store.database_path()).unwrap()[..16],
            b"SQLite format 3\0"
        );
        assert!(store.encrypted_backup_path().is_file());
    }

    #[test]
    fn failed_legacy_unlock_keeps_the_original_encrypted_database() {
        let (store, _, key) = legacy_encrypted_store("legacy-wrong-key", "keep me");
        *key.lock().unwrap() = vec![8_u8; DOCUMENT_KEY_BYTES];

        assert!(matches!(
            store.store.list(None),
            Err(LocalDocumentError::Storage(_))
        ));
        assert_ne!(
            &std::fs::read(store.database_path()).unwrap()[..16],
            b"SQLite format 3\0"
        );
        assert!(!store.encrypted_backup_path().exists());
    }

    #[test]
    fn resolved_profile_drives_database_path_without_requesting_a_key() {
        let root = std::env::temp_dir().join(format!(
            "uniopc-local-documents-test-{}-resolved-profile",
            std::process::id()
        ));
        std::fs::remove_dir_all(&root).ok();
        let seen_profiles = Arc::new(Mutex::new(Vec::new()));
        let store = LocalDocumentStore::from_resolved_profile(
            "alpha".to_string(),
            root.clone(),
            Arc::new(RecordingKeyProvider {
                profiles: Arc::clone(&seen_profiles),
            }),
        );

        store.create(sample_create("consistent profile")).unwrap();

        assert!(seen_profiles.lock().unwrap().is_empty());
        assert_eq!(
            store.database_path,
            root.join("alpha")
                .join(DATABASE_DIRECTORY)
                .join(DATABASE_FILE)
        );
    }

    #[test]
    fn create_writes_version_one() {
        let store = TestStore::isolated("create-version");
        let mut input = sample_create("version one");
        input.category = "unknown-category".to_string();

        let document = store.create(input).unwrap();

        assert_eq!(document.version, 1);
        assert_eq!(document.category, "other");
        assert_eq!(store.version_rows(), vec![(1, "version one".to_string())]);
    }

    #[test]
    fn update_rejects_stale_hash() {
        let store = TestStore::isolated("stale-hash");
        let current = store.create(sample_create("current body")).unwrap();

        let result = store.store.update(LocalDocumentUpdate {
            id: current.id.clone(),
            title: "Changed".to_string(),
            category: "meeting".to_string(),
            blocksuite_body: "changed body".to_string(),
            markdown_projection: "# Changed".to_string(),
            metadata: serde_json::json!({}),
            base_hash: "stale".to_string(),
        });

        assert_eq!(
            result,
            Err(LocalDocumentError::DocumentConflict(
                LocalDocumentConflict {
                    id: current.id,
                    title: current.title,
                    current_hash: current.content_hash,
                    updated_at: current.updated_at,
                }
            ))
        );
        assert_eq!(store.version_rows(), vec![(1, "current body".to_string())]);
    }

    #[test]
    fn update_appends_an_immutable_version() {
        let store = TestStore::isolated("update-version");
        let current = store.create(sample_create("version one")).unwrap();

        let updated = store
            .store
            .update(LocalDocumentUpdate {
                id: current.id,
                title: "Updated".to_string(),
                category: "research".to_string(),
                blocksuite_body: "version two".to_string(),
                markdown_projection: "# Updated".to_string(),
                metadata: serde_json::json!({"source": "test"}),
                base_hash: current.content_hash,
            })
            .unwrap();

        assert_eq!(updated.version, 2);
        assert_eq!(updated.blocksuite_body, "version two");
        assert_eq!(
            store.version_rows(),
            vec![
                (1, "version one".to_string()),
                (2, "version two".to_string())
            ]
        );
    }

    #[test]
    fn archive_hides_from_default_list() {
        let store = TestStore::isolated("archive");
        let document = store.create(sample_create("archive me")).unwrap();

        let archived = store.store.archive(&document.id).unwrap();

        assert_eq!(archived.status, "archived");
        assert!(store.list(None).unwrap().is_empty());
        assert_eq!(store.store.get(&document.id).unwrap().status, "archived");
    }

    #[test]
    fn oversized_body_is_not_written() {
        let store = TestStore::isolated("oversized");
        let body = "x".repeat(16 * 1024 * 1024 + 1);

        assert!(matches!(
            store.create(sample_create(&body)),
            Err(LocalDocumentError::InvalidInput(_))
        ));
        assert!(store.list(None).unwrap().is_empty());
        assert!(store.version_rows().is_empty());
    }
}
