# Uniopc public Windows builds

This repository is a clean source snapshot of Uniopc Desktop **0.4.19** from private source commit `145efd0e0e60c216df77126bbff400b423f8cbd3`. Fresh Git history excludes private history, local changes and release credentials. Application sources and version remain unchanged.

## Signed Windows candidates

The owner can request a Windows x64 candidate from a committed revision already on `main`:

```sh
node scripts/desktop-release-control.mjs candidate --platform windows --dry-run
node scripts/desktop-release-control.mjs candidate --platform windows
```

The controller accepts only `JohnRoosevelt/uniopc-desktop-builds` as its origin. `test/windows/v0.4.19-N` tags start the signed candidate workflow. It requires both the original actor and rerun actor to be `JohnRoosevelt`, verifies main ancestry, checks matching application versions and the Windows updater key, prepares a verified runtime, and builds the installer. Signing jobs use the protected `desktop-signing` environment and only its `TAURI_SIGNING_PRIVATE_KEY_WINDOWS` secret, exposed to key verification and signing steps.

Download `desktop-release-windows-x86_64-ATTEMPT` and `desktop-candidate-manifest-ATTEMPT` from the successful run. **These artifacts are public**, expire after three days, and include signatures, file hashes and build provenance. Signing means **Tauri updater minisign signatures**, not Windows Authenticode. Windows may display an unknown-publisher warning.

A candidate run does not publish to production storage or update the stable channel. No production publication is requested by this change. After testing, publication requires the user's explicit approval of the exact candidate ID, commit, run and attempt:

```sh
node scripts/desktop-release-control.mjs publish --candidate CANDIDATE-ID --commit FULL-SHA --verify-only
# Only after explicit approval of this exact candidate:
node scripts/desktop-release-control.mjs publish --candidate CANDIDATE-ID --commit FULL-SHA
```

`verify-publish/**` verifies the successful owner-built Windows candidate, hashes, updater signature, provenance and live version without production credentials. The production job is entirely skipped. `publish/**` runs the same verification, then enters the protected `desktop-production` environment for owner approval. Only its publication step receives `SUPABASE_STORAGE_API_KEY` and `IMAI_RELEASE_PUBLISH_TOKEN`. It publishes the exact approved bytes without rebuilding, retaining the global storage lock, interrupted-promotion recovery and monotonic stable-version checks. Both environments must require the owner as reviewer and restrict deployment to the corresponding tag patterns, with no branch deployments.

## Runtime cache

Run **Actions → Prepare Windows runtime cache → Run workflow** on **main** before the first candidate. Only the owner can run it; it uses no secrets. The first warm downloads and builds the pinned OpenClaw/Node runtime. Later candidates restore the exact main-branch cache key and avoid that repeated download when inputs are unchanged. A miss builds normally; candidate jobs never write runtime caches or use fallback restore keys.

The key includes platform, architecture, OpenClaw and Node pins, every script, package manifests and locks, Cargo files and Rust runtime sources, Tauri configs, bundled plugins and workflows. The cache contains only the Windows runtime archive and catalog. Every hit is checked against its SHA-256, size, release contract and whitelabel rules; corrupt hits fail closed. The release build still verifies and snapshots the prepared runtime before Tauri packaging. GitHub cache eviction can cause a later rebuild; rerun the main warm workflow to replenish it.

## Unsigned validation

**Actions → Windows validation build → Run workflow** remains available without secrets. Its one-day artifacts use the validation application name and identifier, disable updater artifacts and do not publish. The validation builder retains its forced runtime rebuild.

## Local checks

Use Node.js 22:

```sh
npm ci --legacy-peer-deps
node scripts/check-updater-signing-keys.mjs --platforms windows
node --test scripts/public-release-guard.test.mjs scripts/windows-runtime-cache.test.mjs scripts/desktop-release-workflow.test.mjs scripts/desktop-release-control.test.mjs scripts/desktop-candidate-promotion.test.mjs scripts/desktop-release-candidate.test.mjs
```

A native Windows build also requires Rust stable, the MSVC build tools, Windows SDK and Strawberry Perl. All third-party workflow actions are pinned to immutable commits resolved through their official GitHub repositories.

## Configuration and snapshot provenance

`.env.prod` retains public service URLs and client anon keys. Copywriting and video montage bearer tokens are deliberately blank; token-dependent features remain unavailable without separately provisioned credentials. Never put service-role keys, bearer tokens, signing keys or production release credentials in source, caches or artifacts.

The snapshot points to shared production services, and some data paths may be shared with a normal installation. Use a test account and disposable data.

Exported roots: `src`, `src-tauri`, `public`, `scripts`, `package.json`, `package-lock.json`, `index.html`, `vite.config.js`, `.gitignore`, `.gitattributes`, `.env.brand`, and `.env.example`. `.env.prod` is sanitized from the same immutable revision. Bundled plugin distribution files are required runtime assets. Public build/release workflows, guards, cache helpers and this README are public-build additions.

Excluded: private history, uncommitted source changes, operator instructions, private reports/screenshots, `.env.dev`, local environment files, dependencies, compiler outputs, runtime archives, keys and `.release-secrets`.
