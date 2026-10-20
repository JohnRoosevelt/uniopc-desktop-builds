/// Replace visible upstream brand names in user-facing runtime text while
/// leaving machine identifiers and source files untouched.
pub fn sanitize_runtime_text(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let path_sanitized = sanitize_runtime_paths(input);
    let mut rest = path_sanitized.as_str();
    while !rest.is_empty() {
        let lower = rest.to_ascii_lowercase();
        let ascii = lower.match_indices("openclaw").find_map(|(index, _)| {
            let before = rest[..index].chars().next_back();
            let after = rest[index + 8..].chars().next();
            let identifier = |value: char| {
                value.is_ascii_alphanumeric() || matches!(value, '_' | '.' | '/' | '-')
            };
            (!before.is_some_and(identifier) && !after.is_some_and(identifier)).then_some(index)
        });
        let chinese = rest.find("小龙虾");
        let next = match (ascii, chinese) {
            (Some(a), Some(c)) => Some((a.min(c), if a <= c { 8 } else { "小龙虾".len() })),
            (Some(a), None) => Some((a, 8)),
            (None, Some(c)) => Some((c, "小龙虾".len())),
            (None, None) => None,
        };
        let Some((index, length)) = next else {
            output.push_str(rest);
            break;
        };
        output.push_str(&rest[..index]);
        output.push_str("Uniopc");
        rest = &rest[index + length..];
    }
    output
}

/// Rewrite upstream path components in text shown to people. This runs only
/// on captured output/diagnostics, never on config or process environment.
fn sanitize_runtime_paths(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some((index, length)) = find_path_brand(rest) {
        output.push_str(&rest[..index]);
        output.push_str("uniopc-engine");
        rest = &rest[index + length..];
    }
    output.push_str(rest);
    output
}

fn find_path_brand(input: &str) -> Option<(usize, usize)> {
    let lower = input.to_ascii_lowercase();
    lower.match_indices("openclaw").find_map(|(index, _)| {
        let before = input[..index].chars().next_back();
        let after = input[index + 8..].chars().next();
        let path_component = matches!(before, Some('/' | '\\'))
            || (before.is_none() && after == Some('.'));
        path_component.then_some((index, 8))
    })
}

#[cfg(test)]
mod tests {
    use super::sanitize_runtime_text;

    #[test]
    fn replaces_visible_engine_brand_in_mixed_case_and_chinese() {
        assert_eq!(
            sanitize_runtime_text("OpenClaw openclaw OPENCLAW 小龙虾"),
            "Uniopc Uniopc Uniopc Uniopc"
        );
        assert_eq!(
            sanitize_runtime_text("OPENCLAW_CONFIG_PATH /node_modules/openclaw/openclaw.json"),
            "OPENCLAW_CONFIG_PATH /node_modules/uniopc-engine/uniopc-engine.json"
        );
    }

    #[test]
    fn sanitizes_visible_runtime_paths_without_changing_machine_identifiers() {
        assert_eq!(
            sanitize_runtime_text("failed at /opt/node_modules/openclaw/openclaw.mjs"),
            "failed at /opt/node_modules/uniopc-engine/uniopc-engine.mjs"
        );
        assert_eq!(
            sanitize_runtime_text("OPENCLAW_CONFIG_PATH=node_modules/openclaw/openclaw.json"),
            "OPENCLAW_CONFIG_PATH=node_modules/uniopc-engine/uniopc-engine.json"
        );
        assert_eq!(sanitize_runtime_text("OPENCLAW_CONFIG_PATH"), "OPENCLAW_CONFIG_PATH");
    }
}
