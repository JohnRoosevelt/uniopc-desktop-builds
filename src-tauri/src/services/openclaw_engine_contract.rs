//! Stable product-to-engine contract for the embedded OpenClaw 8.1 runtime.
//!
//! Product connector names must not leak into OpenClaw provider configuration:
//! Codex subscription is a Uniopc connector that writes a canonical `openai/*`
//! model and an explicit model-scoped `codex` runtime policy.

pub const OPENCLAW_ENGINE_VERSION: &str = env!("IMAI_OPENCLAW_VERSION");
pub const CODEX_SUBSCRIPTION_CONNECTOR_ID: &str = "codex-subscription";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorKind {
    CodexSubscription,
    OpenAiApiKey,
    UniopcOfficial,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineModelRoute {
    pub model_ref: String,
    pub agent_runtime_id: Option<String>,
}

impl EngineModelRoute {
    pub fn codex_subscription(model_id: &str) -> Result<Self, String> {
        let model_id = normalize_model_id(model_id)?;
        if !model_id.starts_with("gpt-") {
            return Err("Codex 模型必须是 gpt-*。".to_string());
        }
        Ok(Self {
            model_ref: format!("openai/{model_id}"),
            agent_runtime_id: Some("codex".to_string()),
        })
    }

    pub fn openai_api_key(model_id: &str) -> Result<Self, String> {
        let model_id = normalize_model_id(model_id)?;
        Ok(Self {
            model_ref: format!("openai/{model_id}"),
            agent_runtime_id: None,
        })
    }
}

fn normalize_model_id(model_id: &str) -> Result<&str, String> {
    let model_id = model_id.trim();
    if model_id.is_empty() || model_id.contains('/') {
        return Err("模型 ID 必须是非空的 provider 内部 ID。".to_string());
    }
    Ok(model_id)
}

pub fn parse_exact_engine_version(value: &str) -> Option<String> {
    value
        .split_whitespace()
        .find(|part| part.chars().any(|character| character.is_ascii_digit()) && part.contains('.'))
        .map(|part| {
            part.trim_matches(|character: char| {
                !(character.is_ascii_alphanumeric()
                    || character == '.'
                    || character == '-'
                    || character == '_')
            })
        })
        .filter(|version| !version.is_empty())
        .map(str::to_string)
}

pub fn is_exact_engine_version(value: &str) -> bool {
    parse_exact_engine_version(value).as_deref() == Some(OPENCLAW_ENGINE_VERSION)
}

#[cfg(test)]
mod tests {
    use super::{
        is_exact_engine_version, parse_exact_engine_version, ConnectorKind, EngineModelRoute,
        CODEX_SUBSCRIPTION_CONNECTOR_ID,
    };

    #[test]
    fn codex_subscription_is_canonical_and_explicit() {
        let route = EngineModelRoute::codex_subscription("gpt-5.5").unwrap();

        assert_eq!(route.model_ref, "openai/gpt-5.5");
        assert_eq!(route.agent_runtime_id.as_deref(), Some("codex"));
        assert_eq!(CODEX_SUBSCRIPTION_CONNECTOR_ID, "codex-subscription");
        assert_eq!(
            ConnectorKind::CodexSubscription,
            ConnectorKind::CodexSubscription
        );
    }

    #[test]
    fn api_key_route_does_not_infer_codex_runtime() {
        let route = EngineModelRoute::openai_api_key("gpt-5.5").unwrap();

        assert_eq!(route.model_ref, "openai/gpt-5.5");
        assert_eq!(route.agent_runtime_id, None);
    }

    #[test]
    fn exact_version_accepts_8_1_and_rejects_adjacent_versions() {
        assert_eq!(
            parse_exact_engine_version("openclaw 2026.8.1 (abc123)"),
            Some("2026.8.1".to_string())
        );
        assert!(is_exact_engine_version("2026.8.1"));
        assert!(!is_exact_engine_version("2026.7.1-2"));
        assert!(!is_exact_engine_version("2026.9.1"));
        assert!(!is_exact_engine_version("2026.8.2"));
        assert!(!is_exact_engine_version("dev"));
    }
}
