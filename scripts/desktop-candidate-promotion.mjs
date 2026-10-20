// Bind explicit publication to an exact completed candidate run and attempt.
import { readFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { planRelease, candidateId, validateCandidate, verifyArtifactSignature, filesIn } from './desktop-release-candidate.mjs'
import { readDesktopUpdaterConfs, resolveUpdaterPubkeys } from './check-updater-signing-keys.mjs'

const require = (value, message) => { if (!value) throw new Error(message) }
const versionPattern = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)'
export const PUBLISHER_ONLY_FILES = new Set([
  '.github/workflows/desktop-promote.yml',
  'scripts/desktop-candidate-promotion.mjs', 'scripts/desktop-candidate-promotion.test.mjs',
  'scripts/desktop-release-control.mjs', 'scripts/desktop-release-control.test.mjs',
  'scripts/desktop-release-workflow.test.mjs', 'scripts/desktop-release-candidate.mjs', 'scripts/desktop-release-candidate.test.mjs',
  'docs/desktop-release-signing.md', '.agents/skills/uniopc-desktop-release/SKILL.md',
])
export function verifyPublisherUpdate(sourceCommit, controllerCommit, comparison) {
  require(/^[a-f0-9]{40}$/.test(sourceCommit) && /^[a-f0-9]{40}$/.test(controllerCommit), 'Invalid source/controller commit')
  if (sourceCommit === controllerCommit) return
  require(comparison?.status === 'ahead' && Array.isArray(comparison.files) && comparison.files.every(file => PUBLISHER_ONLY_FILES.has(file.filename) && (!file.previous_filename || PUBLISHER_ONLY_FILES.has(file.previous_filename))), 'Publisher update must preserve all application/build inputs')
}
export function parsePromotionTag(tag) {
  const match = String(tag).match(new RegExp(`^(publish|verify-publish)/((all|desktop|macos|windows)-v(${versionPattern})-([a-f0-9]{12})-([1-9][0-9]*)-([1-9][0-9]*))$`))
  require(match && match[3] === 'windows', 'Use publish/CANDIDATE-ID or verify-publish/CANDIDATE-ID')
  require(Number.isSafeInteger(Number(match[6])) && Number.isSafeInteger(Number(match[7])), 'Invalid source run or attempt')
  return { candidateId: match[2], version: match[4], runId: match[6], runAttempt: match[7], dryRun: match[1] === 'verify-publish' }
}

export function validatePromotionSource({ run, jobs, artifacts, request, commit, comparison }) {
  require(run.repository?.full_name === 'JohnRoosevelt/uniopc-desktop-builds' && run.head_repository?.full_name === 'JohnRoosevelt/uniopc-desktop-builds', 'Candidate must come from this repository')
  require(run.event === 'push' && run.path === '.github/workflows/desktop-release.yml', 'Candidate must come from the tag candidate workflow')
  require(run.status === 'completed' && run.conclusion === 'success', 'Candidate run must have completed successfully')
  require(run.actor?.login === 'JohnRoosevelt' && run.triggering_actor?.login === 'JohnRoosevelt', 'Candidate requires owner actors')
  require(/^test\/windows\/v\d+\.\d+\.\d+-[1-9]\d*$/.test(run.head_branch), 'Candidate requires a Windows test tag')
  verifyPublisherUpdate(run.head_sha, commit, comparison)
  const sourceCommit = run.head_sha
  require(String(run.id) === request.runId && String(run.run_attempt) === request.runAttempt, 'Candidate run/attempt mismatch')
  require(planRelease(run.head_branch).version === request.version, 'Candidate version mismatch')
  require(candidateId({ tag: run.head_branch, commit: sourceCommit, runId: request.runId, runAttempt: request.runAttempt }) === request.candidateId, 'Publication must identify the exact candidate, including its targets')
  for (const name of ['preflight-signing-keys', 'stage-candidate']) require(jobs.some(job => job.name === name && job.conclusion === 'success'), `Candidate gate did not pass: ${name}`)
  const plan = planRelease(run.head_branch)
  const names = [`desktop-candidate-manifest-${request.runAttempt}`, ...plan.targets.map(target => `desktop-release-${target}-${request.runAttempt}`)]
  const selected = names.map(name => {
    const matches = artifacts.filter(artifact => artifact.name === name && !artifact.expired && (!artifact.workflow_run?.head_sha || artifact.workflow_run.head_sha === sourceCommit))
    require(matches.length === 1, `Need exactly one unexpired candidate artifact: ${name}`)
    return { id: String(matches[0].id), name }
  })
  return { source_tag: run.head_branch, source_commit: sourceCommit, source_version: request.version, source_run_id: request.runId, source_attempt: request.runAttempt, dry_run: String(request.dryRun), artifacts: selected }
}

export async function verifyLocalCandidate(candidate, { artifactsDir, repoRoot, request, commit, sourceTag, keys }) {
  validateCandidate(candidate, candidate.id)
  require(candidate.id === request.candidateId && candidate.commit === commit && candidate.tag === sourceTag && candidate.version === request.version && candidate.runId === request.runId && candidate.runAttempt === request.runAttempt, 'Candidate manifest does not match the approved build')
  const trusted = keys || Object.fromEntries(Object.entries(resolveUpdaterPubkeys(readDesktopUpdaterConfs(repoRoot))).map(([target, key]) => [target, key.pubkey]))
  for (const entry of candidate.entries) {
    const files = await filesIn(join(artifactsDir, entry.name))
    const pathFor = name => {
      const matches = files.filter(path => basename(path) === name)
      require(matches.length === 1, 'Candidate file is missing or ambiguous')
      return matches[0]
    }
    const checked = new Set()
    for (const role of ['updater', 'installer', 'signatureFile']) {
      const file = entry[role]
      if (checked.has(file.key)) continue
      const path = pathFor(file.fileName)
      const info = await lstat(path)
      require(info.isFile() && !info.isSymbolicLink(), 'Candidate must contain regular files')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      require(info.size === file.sizeBytes && hash.digest('hex') === file.sha256, 'Tested candidate file hash/size mismatch')
      checked.add(file.key)
    }
    require((await readFile(pathFor(entry.signatureFile.fileName), 'utf8')).trim() === entry.signature, 'Candidate detached signature mismatch')
    const evidence = JSON.parse(await readFile(pathFor('signed-build.json'), 'utf8'))
    require(JSON.stringify(evidence) === JSON.stringify(entry.evidence), 'Candidate build evidence changed')
    await verifyArtifactSignature(pathFor(entry.updater.fileName), entry.signature, trusted[entry.target])
  }
  return candidate
}
