// Reuse only the verified Windows runtime of a completed, same-version tag run.
export function validateWindowsRecoverySource({ run, jobs, artifacts, expectedVersion }) {
  const require = (value, message) => { if (!value) throw new Error(message) }
  require(/^\d+\.\d+\.\d+$/.test(expectedVersion), 'Invalid recovery version')
  require(run.repository?.full_name === '0xbootiful/uniopc-desktop' && run.head_repository?.full_name === '0xbootiful/uniopc-desktop', 'Recovery must use this repository')
  require(run.event === 'push' && run.path === '.github/workflows/desktop-release.yml', 'Recovery must use the tag release workflow')
  require(run.status === 'completed' && run.head_branch === `windows/v${expectedVersion}` && /^[a-f0-9]{40}$/.test(run.head_sha), 'Recovery requires a completed matching Windows tag')
  require(jobs.some(job => job.name === 'preflight-signing-keys' && job.conclusion === 'success'), 'Source version and signing preflight must have passed')
  require(jobs.some(job => job.name.startsWith('windows / prepare-openclaw-runtime-windows (') && job.conclusion === 'success'), 'Source Windows runtime must have passed')
  const runtime = artifacts.filter(artifact => artifact.name === 'prepared-openclaw-runtime-win32-x64' && !artifact.expired)
  require(runtime.length === 1, 'Need exactly one unexpired prepared Windows runtime')
  require(!runtime[0].workflow_run?.head_sha || runtime[0].workflow_run.head_sha === run.head_sha, 'Runtime artifact source commit mismatch')
  return { source_commit: run.head_sha, source_tag: run.head_branch, source_version: expectedVersion, runtime_artifact_id: String(runtime[0].id) }
}
