//! Gateway adapters for the engine's cron ("定时任务") subsystem.
//!
//! The engine ships a complete scheduler; this module is a thin transport over
//! its eight gateway methods. Two deliberate non-features:
//!
//! * **No config writes.** `cron.enabled` defaults to on in the engine
//!   (`cron?.enabled !== false`), so scheduling needs no `config.patch` — which
//!   is what keeps config byte-stable and avoids a sidecar restart mid-turn.
//! * **No new auth path.** Everything rides `openclaw_gateway::call_json` /
//!   `request_json_for_profile`, so the local basic-auth vs remote device-auth
//!   split stays exactly where `endpoint_is_basic_auth()` put it. A local
//!   gateway must never be made to depend on a device identity.
//!
//! Caller scope note: the engine derives a caller scope only for *agent tool*
//! clients (`client.internal.agentRuntimeIdentity`). We connect as an operator,
//! so we have no scope and `cron.list` returns every agent's jobs — which is
//! exactly the cross-employee overview the UI wants.

use crate::services::openclaw_gateway;
use serde_json::{json, Value};

/// Listing and run-history calls walk the whole job store, so they get the
/// same roomier budget the other list-style gateway calls use.
const CRON_LIST_CONNECT_TIMEOUT_SECS: u64 = 5;
const CRON_LIST_REQUEST_TIMEOUT_SECS: u64 = 15;

async fn call(profile: Option<&str>, method: &str, params: Value) -> Result<Value, String> {
    openclaw_gateway::call_json(profile, method, params, false).await
}

async fn call_listish(profile: Option<&str>, method: &str, params: Value) -> Result<Value, String> {
    openclaw_gateway::request_json_for_profile(
        profile,
        method,
        params,
        false,
        CRON_LIST_CONNECT_TIMEOUT_SECS,
        CRON_LIST_REQUEST_TIMEOUT_SECS,
    )
    .await
}

pub async fn list(profile: Option<&str>, params: Value) -> Result<Value, String> {
    call_listish(profile, "cron.list", params).await
}

pub async fn get(profile: Option<&str>, id: &str) -> Result<Value, String> {
    call(profile, "cron.get", json!({ "id": id })).await
}

pub async fn add(profile: Option<&str>, job: Value) -> Result<Value, String> {
    call(profile, "cron.add", job).await
}

pub async fn update(profile: Option<&str>, id: &str, patch: Value) -> Result<Value, String> {
    let mut params = match patch {
        Value::Object(map) => map,
        _ => return Err("定时任务更新参数必须是一个对象。".to_string()),
    };
    params.insert("id".to_string(), Value::String(id.to_string()));
    call(profile, "cron.update", Value::Object(params)).await
}

pub async fn remove(profile: Option<&str>, id: &str) -> Result<Value, String> {
    call(profile, "cron.remove", json!({ "id": id })).await
}

/// `due: true` asks the engine to run only if the job is actually due;
/// the UI's 「立即运行」 always forces a run.
pub async fn run(profile: Option<&str>, id: &str, due: bool) -> Result<Value, String> {
    call(profile, "cron.run", json!({ "id": id, "due": due })).await
}

pub async fn runs(profile: Option<&str>, id: &str, limit: u32) -> Result<Value, String> {
    call_listish(profile, "cron.runs", json!({ "id": id, "limit": limit })).await
}

pub async fn status(profile: Option<&str>) -> Result<Value, String> {
    call(profile, "cron.status", json!({})).await
}
