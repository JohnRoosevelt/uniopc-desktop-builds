# Windows desktop startup observation

The observer is an external, read-only diagnostic tool for Windows PowerShell 5.1. It never starts or terminates the desktop or gateway, changes configuration, repairs a profile, or changes the runtime. Start the observer before the operator starts the desktop. The operator controls the application separately.

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\observe-windows-desktop-startup.ps1 -OutputJsonl C:\Temp\startup-observation.jsonl -BudgetSeconds 1500
```

The output parent directory must exist. The output must be a new `.jsonl` file outside Uniopc application data; an existing file is never overwritten. Defaults are a 1500 second observation, a 2000 ms sample interval, a 1000 ms HTTP timeout and a 500 ms CIM wait. A slow sample creates lag evidence; the observer does not schedule catch-up jobs. At most one in-process CIM operation remains pending. No PowerShell jobs or external helper processes are started by the observer.

The fixed readiness probe is `http://127.0.0.1:28790/readyz`. Proxy use, redirects and connection reuse are disabled. Requests have bounded timeouts, consume at most 8193 bytes, retain only the status and bounded byte count, and dispose the response. The body is never saved. A 200 response is HTTP evidence; it proves neither authentication nor plugin/default-model postconditions.

The event input defaults to `%APPDATA%\Uniopc\diagnostics\engine-startup-events.jsonl`. The gateway log is selected privately from `active-profile.json`; the profile key and selected path are never included in output. A timeline is read only when explicitly provided with `-TimelinePath`. The observer never scans user directories for timelines. All sources begin at their initial byte offset. An initial incomplete line is discarded. Use guest-local files for inputs; shared filesystems may expose unstable file IDs and will be reported as gaps. File identity changes and truncation produce a gap and advance to the replacement file's end, rather than replay historical records. Reads are bounded to 64 KiB per source per tick, with a 16 KiB line/partial limit.

Only fixed phase/outcome enums, numbers and process birth identities are retained. Raw logs, `detail`, command lines, environment values, profile keys, tokens, prompts and session identifiers are never saved. Unknown messages are ignored. Native progress is limited to `node_preload`, `http_listen_requested`, `listening` and numeric heartbeat fields; external gateway log lines lack reliable child identity and remain unattributed.

A process identity is `(pid, created_utc)`, not a PID alone. The observer obtains app identities and node descendants using OS process ancestry and birth checks, then samples CPU time, working set, handles and I/O counters through read-only process APIs. Nodes are reported as `gateway_candidate`, because ancestry does not prove which child owns the gateway port. Counter or CIM failures are unavailable values, never zero. The summary computes deltas only within the same birth identity and the actual interval between monotonic samples. CPU percent is per core and can exceed 100 for a multithreaded process. A reset/unavailable counter breaks its interval.

The current desktop event schema has no app PID, creation time or run ID. Its new events are therefore **unattributed evidence**. In particular, candidate 9 cannot establish authenticated startup success from these logs. Do not use profile, event order or wall-clock timestamps as substitutes. A future identifiable event requires `appPid`, `appCreatedUtc` (seven fractional digits, UTC), and `runId`, matching a currently observed app birth identity. The observer converts private run IDs into local numeric flights; it does not save raw IDs. Repeated requests for a run are requests, not spawns. A terminal success requires `auth_ready` followed by `startup_finished` with `connected` for the current verified flight. A timeout remains incomplete.

An optional timeline is JSONL with a fixed `phase` (`runtime`, `loader`, `sdk`, `plugins`, `gateway`), a private string `clockId`, and numeric `startMs`/`durationMs`. Clock IDs become local numeric trace origins. Other timeline formats are ignored. Nested and overlapping spans form a union inside one origin; spans from different origins are never added or aligned to observer elapsed time.

```sh
node scripts/summarize-windows-desktop-startup.mjs startup-observation.jsonl
node --test scripts/summarize-windows-desktop-startup.test.mjs
```

The summary accepts at most 32 MiB and 16 KiB per line. It strips unknown fields and never echoes malformed/raw records. Outcomes are `authenticated_connected`, `failed`, or `incomplete`. Its `observer_elapsed_ms` is from the observer Stopwatch. UTC is contextual only and may jump. Optional structured `host_receive` rows contain a host monotonic `host_ms`; their receive window is reported independently. Subtracting observer time from host receipt time would be invalid, including when a host receives a batch long after capture.

A preserved-profile warm run measures the existing installed runtime/profile. It does not measure first extraction. First extraction requires a separate, explicitly prepared experiment; never delete a profile or runtime to simulate it as part of observation. A partial file, missing attribution, source gap, counter failure, or observation timeout must remain visible in the report.
