use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentAssessment {
    Accepted,
    Required,
    LegacyRepairRequired,
    Stale,
    Unknown,
}

/// Classify OpenClaw 8.1 consent diagnostics without turning a diagnostic into
/// a false-positive installation state. The CLI remains authoritative for the
/// actual write; this adapter only exposes an actionable lifecycle state.
pub fn assess_consent_diagnostics(diagnostics: &str) -> ConsentAssessment {
    let normalized = diagnostics.to_ascii_lowercase();
    if normalized.contains("requires capability consent") {
        ConsentAssessment::Required
    } else if normalized.contains("acceptedsurface")
        && (normalized.contains("missing") || normalized.contains("absent"))
    {
        ConsentAssessment::LegacyRepairRequired
    } else if normalized.contains("capability consent is stale")
        || normalized.contains("accepted surface is stale")
        || normalized.contains("capability surface changed")
    {
        ConsentAssessment::Stale
    } else {
        ConsentAssessment::Unknown
    }
}

pub fn assess_registry_record(record: &Value) -> ConsentAssessment {
    let Some(record) = record.as_object() else {
        return ConsentAssessment::Unknown;
    };
    let has_surface = record.get("acceptedSurface").is_some();
    let has_hash = record
        .get("acceptedSurfaceHash")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let has_integrity = record
        .get("acceptedSurfaceIntegrity")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    if has_surface && has_hash && has_integrity {
        ConsentAssessment::Accepted
    } else if record.contains_key("acceptedSurface") {
        ConsentAssessment::Stale
    } else {
        ConsentAssessment::LegacyRepairRequired
    }
}

#[cfg(test)]
mod tests {
    use super::{assess_consent_diagnostics, ConsentAssessment};

    #[test]
    fn requires_capability_consent_diagnostic_is_not_an_install_success() {
        assert_eq!(
            assess_consent_diagnostics(
                r#"Plugin \"uniopc-montage\" requires capability consent. Use openclaw plugins enable uniopc-montage --accept-capabilities."#,
            ),
            ConsentAssessment::Required
        );
    }

    #[test]
    fn missing_accepted_surface_requires_legacy_repair() {
        assert_eq!(
            assess_consent_diagnostics("installed plugin record missing acceptedSurface"),
            ConsentAssessment::LegacyRepairRequired
        );
    }

    #[test]
    fn stale_accepted_surface_is_not_treated_as_accepted() {
        assert_eq!(
            assess_consent_diagnostics("capability consent is stale for this artifact"),
            ConsentAssessment::Stale
        );
    }
}
