//! 定时任务 commands.
//!
//! The engine's schedule model (`at` / `every` / `cron` / `on-exit`) is not
//! something business users should have to type. The UI speaks a small
//! human-shaped form — 单次 / 每天 / 每周 / 每隔 / 高级表达式 — and this module
//! is the single place that translates it in both directions. Doing it in Rust
//! (rather than in the page) keeps one implementation under `cargo test`,
//! because the lossy direction — reducing an arbitrary cron expression back to
//! "每周一、三 09:00" — is where the bugs live.
//!
//! Two engine facts this translation is pinned to (verified against the bundled
//! runtime, NOT the public docs, which are misleading here):
//!
//! * The expression parser is `croner`, standard numbering:
//!   `0=Sun, 1=Mon … 6=Sat, and 7 is also Sunday`. So ISO weekday numbers
//!   (1=Mon … 7=Sun) can be emitted verbatim — but a `0` read back from an
//!   expression a human or an agent wrote means Sunday and must fold to 7.
//! * `schedule.tz`, when empty, falls back to the **gateway host's** zone
//!   (`Intl.DateTimeFormat().resolvedOptions().timeZone`) — not UTC. That is
//!   accidentally right for a local engine and wrong for a remote 7×24 host,
//!   so the caller's IANA zone is always sent explicitly.

use crate::services::openclaw_cron;
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const DEFAULT_RUN_HISTORY_LIMIT: u32 = 50;

const MODE_ONCE: &str = "once";
const MODE_DAILY: &str = "daily";
const MODE_WEEKLY: &str = "weekly";
const MODE_INTERVAL: &str = "interval";
const MODE_EXPR: &str = "expr";

const UNIT_SECONDS: &str = "seconds";
const UNIT_MINUTES: &str = "minutes";
const UNIT_HOURS: &str = "hours";
const UNIT_DAYS: &str = "days";

const MS_SECOND: i64 = 1_000;
const MS_MINUTE: i64 = 60 * MS_SECOND;
const MS_HOUR: i64 = 60 * MS_MINUTE;
const MS_DAY: i64 = 24 * MS_HOUR;

/// The UI-facing schedule. `mode` selects which of the other fields matter;
/// the rest carry sane values so the editor can switch modes without losing
/// what the user already typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleForm {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub once_at_ms: Option<i64>,
    /// "HH:MM", 24h.
    #[serde(default)]
    pub time: String,
    /// ISO weekdays, 1=Mon … 7=Sun.
    #[serde(default)]
    pub days: Vec<u8>,
    #[serde(default)]
    pub every_value: u32,
    #[serde(default)]
    pub every_unit: String,
    #[serde(default)]
    pub expr: String,
    #[serde(default)]
    pub tz: String,
}

impl Default for ScheduleForm {
    fn default() -> Self {
        Self {
            mode: MODE_DAILY.to_string(),
            once_at_ms: None,
            time: "09:00".to_string(),
            days: vec![1, 2, 3, 4, 5],
            every_value: 1,
            every_unit: UNIT_HOURS.to_string(),
            expr: String::new(),
            tz: String::new(),
        }
    }
}

fn all_weekdays() -> Vec<u8> {
    vec![1, 2, 3, 4, 5, 6, 7]
}

fn parse_hh_mm(value: &str) -> Result<(u32, u32), String> {
    let trimmed = value.trim();
    let (hour_raw, minute_raw) = trimmed
        .split_once(':')
        .ok_or_else(|| format!("时间格式应为 HH:MM，收到 `{trimmed}`。"))?;
    let hour: u32 = hour_raw
        .trim()
        .parse()
        .map_err(|_| format!("无法解析小时 `{hour_raw}`。"))?;
    // Tolerate a trailing ":SS" so an "09:00:00" coming back from another
    // client does not hard-fail the editor.
    let minute_text = minute_raw.trim().split(':').next().unwrap_or("");
    let minute: u32 = minute_text
        .parse()
        .map_err(|_| format!("无法解析分钟 `{minute_raw}`。"))?;
    if hour > 23 || minute > 59 {
        return Err(format!("时间超出范围：`{trimmed}`。"));
    }
    Ok((hour, minute))
}

fn normalize_days(days: &[u8]) -> Result<Vec<u8>, String> {
    let mut normalized: Vec<u8> = Vec::new();
    for day in days {
        // croner treats 0 and 7 as the same Sunday; the form is ISO-only.
        let iso = if *day == 0 { 7 } else { *day };
        if !(1..=7).contains(&iso) {
            return Err(format!("无效的星期 `{day}`，应为 1(周一)~7(周日)。"));
        }
        if !normalized.contains(&iso) {
            normalized.push(iso);
        }
    }
    normalized.sort_unstable();
    if normalized.is_empty() {
        return Err("请至少选择一天。".to_string());
    }
    Ok(normalized)
}

fn unit_to_ms(unit: &str) -> Result<i64, String> {
    match unit.trim() {
        UNIT_SECONDS => Ok(MS_SECOND),
        UNIT_MINUTES | "" => Ok(MS_MINUTE),
        UNIT_HOURS => Ok(MS_HOUR),
        UNIT_DAYS => Ok(MS_DAY),
        other => Err(format!("无效的间隔单位 `{other}`。")),
    }
}

/// Splits `everyMs` into the largest unit that divides it exactly, so a job
/// created as "每 2 小时" reads back as 2 hours rather than 120 minutes.
fn ms_to_interval(every_ms: i64) -> (u32, &'static str) {
    for (unit_ms, unit) in [
        (MS_DAY, UNIT_DAYS),
        (MS_HOUR, UNIT_HOURS),
        (MS_MINUTE, UNIT_MINUTES),
        (MS_SECOND, UNIT_SECONDS),
    ] {
        if every_ms >= unit_ms && every_ms % unit_ms == 0 {
            return ((every_ms / unit_ms) as u32, unit);
        }
    }
    // Sub-second or otherwise unrepresentable: show it as seconds, rounded up
    // so the editor never renders a 0.
    let seconds = ((every_ms + MS_SECOND - 1) / MS_SECOND).max(1);
    (seconds as u32, UNIT_SECONDS)
}

/// Expands a cron day-of-week field into ISO weekdays.
///
/// Returns `None` for anything we refuse to round-trip — names (`MON`),
/// step/nth/last syntax (`*/2`, `5#2`, `5L`) — which sends the form to
/// 高级表达式 mode instead of silently rewriting the user's expression.
fn parse_dow_field(field: &str) -> Option<Vec<u8>> {
    let trimmed = field.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "*" || trimmed == "?" {
        return Some(all_weekdays());
    }
    if trimmed
        .chars()
        .any(|ch| !ch.is_ascii_digit() && ch != ',' && ch != '-')
    {
        return None;
    }
    let mut days: Vec<u8> = Vec::new();
    let push = |value: u8, days: &mut Vec<u8>| -> bool {
        if value > 7 {
            return false;
        }
        let iso = if value == 0 { 7 } else { value };
        if !days.contains(&iso) {
            days.push(iso);
        }
        true
    };
    for token in trimmed.split(',') {
        let token = token.trim();
        if token.is_empty() {
            return None;
        }
        match token.split_once('-') {
            Some((start_raw, end_raw)) => {
                let start: u8 = start_raw.trim().parse().ok()?;
                let end: u8 = end_raw.trim().parse().ok()?;
                if start > end || end > 7 {
                    return None;
                }
                for value in start..=end {
                    if !push(value, &mut days) {
                        return None;
                    }
                }
            }
            None => {
                let value: u8 = token.parse().ok()?;
                if !push(value, &mut days) {
                    return None;
                }
            }
        }
    }
    if days.is_empty() {
        return None;
    }
    days.sort_unstable();
    Some(days)
}

fn format_dow_field(days: &[u8]) -> String {
    if days.len() == 7 {
        return "*".to_string();
    }
    days.iter()
        .map(|day| day.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn optional_tz(tz: &str) -> Option<String> {
    let trimmed = tz.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// UI form → engine `schedule` object.
pub fn schedule_form_to_engine(form: &ScheduleForm) -> Result<Value, String> {
    let tz = optional_tz(&form.tz);
    match form.mode.trim() {
        MODE_ONCE => {
            let at_ms = form
                .once_at_ms
                .ok_or_else(|| "请设置执行时间。".to_string())?;
            let at = Utc
                .timestamp_millis_opt(at_ms)
                .single()
                .ok_or_else(|| format!("无效的执行时间戳 `{at_ms}`。"))?;
            Ok(json!({
                "kind": "at",
                "at": at.to_rfc3339_opts(SecondsFormat::Secs, true),
            }))
        }
        MODE_INTERVAL => {
            let unit_ms = unit_to_ms(&form.every_unit)?;
            if form.every_value == 0 {
                return Err("间隔必须大于 0。".to_string());
            }
            Ok(json!({
                "kind": "every",
                "everyMs": i64::from(form.every_value) * unit_ms,
            }))
        }
        MODE_EXPR => {
            let expr = form.expr.trim();
            if expr.is_empty() {
                return Err("请填写 cron 表达式。".to_string());
            }
            let mut schedule = Map::new();
            schedule.insert("kind".to_string(), Value::String("cron".to_string()));
            schedule.insert("expr".to_string(), Value::String(expr.to_string()));
            if let Some(tz) = tz {
                schedule.insert("tz".to_string(), Value::String(tz));
            }
            Ok(Value::Object(schedule))
        }
        mode @ (MODE_DAILY | MODE_WEEKLY) => {
            let (hour, minute) = parse_hh_mm(&form.time)?;
            let days = if mode == MODE_DAILY {
                all_weekdays()
            } else {
                normalize_days(&form.days)?
            };
            let mut schedule = Map::new();
            schedule.insert("kind".to_string(), Value::String("cron".to_string()));
            schedule.insert(
                "expr".to_string(),
                Value::String(format!("{minute} {hour} * * {}", format_dow_field(&days))),
            );
            if let Some(tz) = tz {
                schedule.insert("tz".to_string(), Value::String(tz));
            }
            Ok(Value::Object(schedule))
        }
        other => Err(format!("未知的调度模式 `{other}`。")),
    }
}

fn expr_fields_minute_hour_dow(expr: &str) -> Option<(&str, &str, &str, &str, &str)> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    match fields.len() {
        // MIN HOUR DOM MON DOW
        5 => Some((fields[0], fields[1], fields[2], fields[3], fields[4])),
        // SEC MIN HOUR DOM MON DOW — only reducible when it fires at :00 seconds.
        6 if fields[0] == "0" => Some((fields[1], fields[2], fields[3], fields[4], fields[5])),
        _ => None,
    }
}

/// Engine `schedule` object → UI form. Anything that will not reduce cleanly
/// lands in 高级表达式 mode rather than being approximated.
pub fn schedule_engine_to_form(schedule: &Value) -> ScheduleForm {
    let kind = schedule.get("kind").and_then(Value::as_str).unwrap_or("");
    let tz = schedule
        .get("tz")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    match kind {
        "at" => {
            let at_ms = schedule
                .get("atMs")
                .and_then(Value::as_i64)
                .or_else(|| {
                    schedule
                        .get("at")
                        .and_then(Value::as_str)
                        .and_then(|at| DateTime::parse_from_rfc3339(at.trim()).ok())
                        .map(|at| at.timestamp_millis())
                });
            ScheduleForm {
                mode: MODE_ONCE.to_string(),
                once_at_ms: at_ms,
                tz,
                ..Default::default()
            }
        }
        "every" => {
            let every_ms = schedule
                .get("everyMs")
                .and_then(Value::as_i64)
                .unwrap_or(MS_HOUR)
                .max(1);
            let (every_value, every_unit) = ms_to_interval(every_ms);
            ScheduleForm {
                mode: MODE_INTERVAL.to_string(),
                every_value,
                every_unit: every_unit.to_string(),
                tz,
                ..Default::default()
            }
        }
        "cron" => {
            let expr = schedule
                .get("expr")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let reduced = expr_fields_minute_hour_dow(&expr).and_then(
                |(minute, hour, dom, month, dow)| {
                    if dom != "*" && dom != "?" {
                        return None;
                    }
                    if month != "*" && month != "?" {
                        return None;
                    }
                    let minute: u32 = minute.parse().ok()?;
                    let hour: u32 = hour.parse().ok()?;
                    if minute > 59 || hour > 23 {
                        return None;
                    }
                    let days = parse_dow_field(dow)?;
                    Some((minute, hour, days))
                },
            );
            match reduced {
                Some((minute, hour, days)) => {
                    let is_daily = days.len() == 7;
                    ScheduleForm {
                        mode: if is_daily { MODE_DAILY } else { MODE_WEEKLY }.to_string(),
                        time: format!("{hour:02}:{minute:02}"),
                        days,
                        expr,
                        tz,
                        ..Default::default()
                    }
                }
                None => ScheduleForm {
                    mode: MODE_EXPR.to_string(),
                    expr,
                    tz,
                    ..Default::default()
                },
            }
        }
        // `on-exit` (and anything the engine adds later) has no humane form;
        // surface it read-only rather than pretending we can edit it.
        _ => ScheduleForm {
            mode: MODE_EXPR.to_string(),
            expr: schedule
                .get("expr")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            tz,
            ..Default::default()
        },
    }
}

/// Attaches the humanized form to a job so the page renders without carrying a
/// second copy of this translation in JS.
fn augment_job(job: &mut Value) {
    let form = job
        .get("schedule")
        .map(schedule_engine_to_form)
        .unwrap_or_default();
    if let Some(object) = job.as_object_mut() {
        if let Ok(value) = serde_json::to_value(&form) {
            object.insert("scheduleForm".to_string(), value);
        }
    }
}

fn augment_jobs(mut payload: Value) -> Value {
    if let Some(jobs) = payload.get_mut("jobs").and_then(Value::as_array_mut) {
        for job in jobs.iter_mut() {
            augment_job(job);
        }
    }
    payload
}

fn profile_ref(profile: &Option<String>) -> Option<&str> {
    profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronSaveRequest {
    #[serde(default)]
    pub profile: Option<String>,
    /// Present on edit, absent on create.
    #[serde(default)]
    pub id: Option<String>,
    pub schedule: ScheduleForm,
    /// Everything else the engine's job shape accepts: name, description,
    /// agentId, enabled, sessionTarget, payload, delivery, failureAlert,
    /// deleteAfterRun. Passed through untouched so adding a field to the editor
    /// needs no Rust change.
    #[serde(default)]
    pub job: Value,
}

fn merge_schedule_into_job(request: &CronSaveRequest) -> Result<Value, String> {
    let schedule = schedule_form_to_engine(&request.schedule)?;
    let mut job = match request.job.clone() {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        _ => return Err("定时任务参数必须是一个对象。".to_string()),
    };
    job.insert("schedule".to_string(), schedule);
    Ok(Value::Object(job))
}

#[tauri::command]
pub async fn openclaw_cron_list(
    profile: Option<String>,
    params: Option<Value>,
) -> Result<Value, String> {
    let mut params = match params {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    // The overview shows paused and broken jobs too — hiding them is how a
    // job that the engine auto-disabled after 10 failures becomes invisible.
    params
        .entry("includeDisabled".to_string())
        .or_insert(Value::Bool(true));
    let payload = openclaw_cron::list(profile_ref(&profile), Value::Object(params)).await?;
    Ok(augment_jobs(payload))
}

#[tauri::command]
pub async fn openclaw_cron_get(profile: Option<String>, id: String) -> Result<Value, String> {
    let mut job = openclaw_cron::get(profile_ref(&profile), id.trim()).await?;
    augment_job(&mut job);
    Ok(job)
}

#[tauri::command]
pub async fn openclaw_cron_add(request: CronSaveRequest) -> Result<Value, String> {
    let job = merge_schedule_into_job(&request)?;
    openclaw_cron::add(profile_ref(&request.profile), job).await
}

#[tauri::command]
pub async fn openclaw_cron_update(request: CronSaveRequest) -> Result<Value, String> {
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少定时任务 id。".to_string())?
        .to_string();
    let job = merge_schedule_into_job(&request)?;
    openclaw_cron::update(profile_ref(&request.profile), &id, job).await
}

/// Enable/disable and other single-field edits skip the schedule round-trip
/// entirely — re-sending a reduced schedule on an unrelated toggle is how a
/// 高级表达式 job silently loses its expression.
#[tauri::command]
pub async fn openclaw_cron_patch(
    profile: Option<String>,
    id: String,
    patch: Value,
) -> Result<Value, String> {
    openclaw_cron::update(profile_ref(&profile), id.trim(), patch).await
}

#[tauri::command]
pub async fn openclaw_cron_remove(profile: Option<String>, id: String) -> Result<Value, String> {
    openclaw_cron::remove(profile_ref(&profile), id.trim()).await
}

#[tauri::command]
pub async fn openclaw_cron_run(profile: Option<String>, id: String) -> Result<Value, String> {
    openclaw_cron::run(profile_ref(&profile), id.trim(), false).await
}

#[tauri::command]
pub async fn openclaw_cron_runs(
    profile: Option<String>,
    id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let limit = limit.unwrap_or(DEFAULT_RUN_HISTORY_LIMIT).clamp(1, 200);
    openclaw_cron::runs(profile_ref(&profile), id.trim(), limit).await
}

#[tauri::command]
pub async fn openclaw_cron_status(profile: Option<String>) -> Result<Value, String> {
    openclaw_cron::status(profile_ref(&profile)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(mode: &str) -> ScheduleForm {
        ScheduleForm {
            mode: mode.to_string(),
            tz: "Asia/Shanghai".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn daily_emits_wildcard_dow_and_explicit_tz() {
        let mut input = form(MODE_DAILY);
        input.time = "09:05".to_string();
        let schedule = schedule_form_to_engine(&input).expect("daily schedule");
        assert_eq!(schedule["kind"], "cron");
        assert_eq!(schedule["expr"], "5 9 * * *");
        // The engine falls back to the GATEWAY HOST's zone when tz is absent,
        // which is wrong the moment the engine is a remote 7x24 box.
        assert_eq!(schedule["tz"], "Asia/Shanghai");
    }

    #[test]
    fn weekly_emits_iso_weekdays_verbatim() {
        let mut input = form(MODE_WEEKLY);
        input.time = "18:30".to_string();
        input.days = vec![5, 1, 3];
        let schedule = schedule_form_to_engine(&input).expect("weekly schedule");
        assert_eq!(schedule["expr"], "30 18 * * 1,3,5");
    }

    #[test]
    fn weekly_covering_all_seven_days_collapses_to_daily() {
        let mut input = form(MODE_WEEKLY);
        input.time = "07:00".to_string();
        input.days = all_weekdays();
        let schedule = schedule_form_to_engine(&input).expect("weekly schedule");
        assert_eq!(schedule["expr"], "0 7 * * *");
        assert_eq!(schedule_engine_to_form(&schedule).mode, MODE_DAILY);
    }

    #[test]
    fn round_trip_preserves_workday_morning_brief() {
        let mut input = form(MODE_WEEKLY);
        input.time = "08:00".to_string();
        input.days = vec![1, 2, 3, 4, 5];
        let schedule = schedule_form_to_engine(&input).expect("weekly schedule");
        let back = schedule_engine_to_form(&schedule);
        assert_eq!(back.mode, MODE_WEEKLY);
        assert_eq!(back.time, "08:00");
        assert_eq!(back.days, vec![1, 2, 3, 4, 5]);
        assert_eq!(back.tz, "Asia/Shanghai");
        assert_eq!(
            schedule_form_to_engine(&back).expect("re-encode"),
            schedule,
            "second encode must be byte-identical to the first"
        );
    }

    #[test]
    fn sunday_written_as_zero_folds_to_iso_seven() {
        // croner: 0 and 7 are both Sunday. An agent-written expression may use
        // either; the form is ISO-only.
        let schedule = json!({ "kind": "cron", "expr": "0 9 * * 0" });
        let back = schedule_engine_to_form(&schedule);
        assert_eq!(back.mode, MODE_WEEKLY);
        assert_eq!(back.days, vec![7]);
        assert_eq!(
            schedule_form_to_engine(&back).expect("re-encode")["expr"],
            "0 9 * * 7"
        );
    }

    #[test]
    fn dow_ranges_and_lists_expand() {
        assert_eq!(parse_dow_field("1-5"), Some(vec![1, 2, 3, 4, 5]));
        assert_eq!(parse_dow_field("1,3,5"), Some(vec![1, 3, 5]));
        assert_eq!(parse_dow_field("6,0"), Some(vec![6, 7]));
        assert_eq!(parse_dow_field("0-6"), Some(all_weekdays()));
        assert_eq!(parse_dow_field("*"), Some(all_weekdays()));
    }

    #[test]
    fn unreducible_expressions_stay_in_advanced_mode() {
        // Named days, steps, nth-occurrence and last-of-month are all things we
        // refuse to rewrite — reducing them would silently change the schedule.
        for expr in ["0 9 * * MON", "0 9 * * */2", "0 9 * * 5#2", "0 9 1 * *"] {
            let form = schedule_engine_to_form(&json!({ "kind": "cron", "expr": expr }));
            assert_eq!(form.mode, MODE_EXPR, "expr `{expr}` must stay advanced");
            assert_eq!(form.expr, expr, "expr `{expr}` must survive untouched");
        }
    }

    #[test]
    fn six_field_expression_reduces_only_at_zero_seconds() {
        let at_zero = schedule_engine_to_form(&json!({ "kind": "cron", "expr": "0 30 9 * * 1-5" }));
        assert_eq!(at_zero.mode, MODE_WEEKLY);
        assert_eq!(at_zero.time, "09:30");

        let at_thirty =
            schedule_engine_to_form(&json!({ "kind": "cron", "expr": "30 0 9 * * 1-5" }));
        assert_eq!(at_thirty.mode, MODE_EXPR);
    }

    #[test]
    fn interval_round_trips_through_the_largest_exact_unit() {
        let mut input = form(MODE_INTERVAL);
        input.every_value = 2;
        input.every_unit = UNIT_HOURS.to_string();
        let schedule = schedule_form_to_engine(&input).expect("interval schedule");
        assert_eq!(schedule["everyMs"], 2 * MS_HOUR);

        let back = schedule_engine_to_form(&schedule);
        assert_eq!(back.every_value, 2);
        assert_eq!(back.every_unit, UNIT_HOURS);

        // 90 minutes has no whole-hour form and must not round to 1 or 2 hours.
        let ninety = schedule_engine_to_form(&json!({ "kind": "every", "everyMs": 90 * MS_MINUTE }));
        assert_eq!(ninety.every_value, 90);
        assert_eq!(ninety.every_unit, UNIT_MINUTES);
    }

    #[test]
    fn once_round_trips_as_utc_instant() {
        let mut input = form(MODE_ONCE);
        input.once_at_ms = Some(1_785_000_000_000);
        let schedule = schedule_form_to_engine(&input).expect("at schedule");
        assert_eq!(schedule["kind"], "at");
        assert!(schedule["at"].as_str().expect("at string").ends_with('Z'));

        let back = schedule_engine_to_form(&schedule);
        assert_eq!(back.mode, MODE_ONCE);
        assert_eq!(back.once_at_ms, Some(1_785_000_000_000));
    }

    #[test]
    fn once_also_reads_the_engines_at_ms_mirror() {
        let back = schedule_engine_to_form(&json!({ "kind": "at", "atMs": 1_785_000_000_000i64 }));
        assert_eq!(back.mode, MODE_ONCE);
        assert_eq!(back.once_at_ms, Some(1_785_000_000_000));
    }

    #[test]
    fn on_exit_jobs_are_surfaced_not_mangled() {
        let form = schedule_engine_to_form(&json!({
            "kind": "on-exit",
            "command": "npm run build",
        }));
        assert_eq!(form.mode, MODE_EXPR);
    }

    #[test]
    fn empty_weekday_selection_is_rejected() {
        let mut input = form(MODE_WEEKLY);
        input.days = vec![];
        assert!(schedule_form_to_engine(&input).is_err());
    }

    #[test]
    fn list_augmentation_attaches_the_humanized_form() {
        let payload = augment_jobs(json!({
            "jobs": [{ "id": "a", "schedule": { "kind": "cron", "expr": "0 9 * * 1-5" } }],
        }));
        assert_eq!(payload["jobs"][0]["scheduleForm"]["mode"], MODE_WEEKLY);
        assert_eq!(payload["jobs"][0]["scheduleForm"]["time"], "09:00");
    }

    #[test]
    fn save_request_merges_schedule_over_whatever_the_editor_sent() {
        let request = CronSaveRequest {
            profile: None,
            id: None,
            schedule: {
                let mut input = form(MODE_DAILY);
                input.time = "09:00".to_string();
                input
            },
            job: json!({ "name": "晨间简报", "agentId": "sales", "schedule": "garbage" }),
        };
        let job = merge_schedule_into_job(&request).expect("merged job");
        assert_eq!(job["name"], "晨间简报");
        assert_eq!(job["agentId"], "sales");
        assert_eq!(job["schedule"]["expr"], "0 9 * * *");
    }
}
