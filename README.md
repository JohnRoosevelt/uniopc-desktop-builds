# Uniopc public Windows build validation

This repository is a clean source snapshot of Uniopc Desktop 0.4.19 from private source commit `145efd0e0e60c216df77126bbff400b423f8cbd3`. It has fresh Git history and excludes private repository history, local changes, private release configuration, and production signing credentials.

Run **Actions → Windows validation build → Run workflow** to build a Windows x64 test installer on a standard `windows-latest` runner. The workflow is manual only. It needs no Actions Secrets. Artifacts expire after one day.

The installer is **unsigned validation software**, not a production release. It uses the validation application name and identifier, produces no updater artifacts, and neither uploads to production storage nor changes the update channel. Windows may warn about an unsigned installer. Formal signing and release remain in the private repository.

## Local checks

Use Node.js 22 and run:

```sh
npm ci --legacy-peer-deps
node scripts/check-updater-signing-keys.mjs --platforms windows
node --test scripts/build-desktop-validation.test.mjs
npm run build
```

A native Windows build also requires Rust stable, the MSVC build tools, Windows SDK, and Strawberry Perl:

```sh
npm run build:validation -- --target x86_64-pc-windows-msvc
```

## Configuration and test data

`.env.prod` retains public service URLs and client anon keys needed by the application. Copywriting and video montage bearer tokens are deliberately blank; montage and other token-dependent features are unavailable without separately provisioned credentials. Never put service-role keys, bearer tokens, signing keys, or production release credentials in this public repository or its artifacts.

Validation is not an isolated backend sandbox: the snapshot still points to shared production services, and some local data paths may be shared with a normal installation. Use a test account and disposable test data; do not run it beside a production installation with valuable state.

## Snapshot provenance

Exported roots: `src`, `src-tauri`, `public`, `scripts`, `package.json`, `package-lock.json`, `index.html`, `vite.config.js`, `.gitignore`, `.gitattributes`, `.env.brand`, and `.env.example`. `.env.prod` is sanitized from the same immutable source revision. Bundled plugin distribution files are retained as required runtime assets. The README, additional ignore rules, and the sole manual validation workflow are public-build additions.

Excluded: old workflows, private history, uncommitted changes, operator/agent instructions, private documentation/reports/screenshots, `.env.dev`, local environment files, dependencies, compiler outputs, runtime archives, keys, and `.release-secrets`.

Passing this workflow validates test packaging only. Promote only the same reviewed source revision through the private repository's signing and candidate approval process before any production release.
