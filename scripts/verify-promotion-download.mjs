#!/usr/bin/env node
import { readFile, mkdir, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parsePromotionTag, verifyLocalCandidate } from './desktop-candidate-promotion.mjs'
import { createStorage } from './desktop-release-candidate.mjs'
import { compareReleaseVersions } from './release-desktop-updater.mjs'
const request = parsePromotionTag(process.env.GITHUB_REF_NAME)
if (process.argv[2] === 'prepare') {
  await mkdir('approved/release', { recursive: true })
  await rename(`downloaded/desktop-candidate-manifest-${request.runAttempt}/candidate.json`, 'approved/candidate.json')
  await rename(`downloaded/desktop-release-windows-x86_64-${request.runAttempt}`, 'approved/release/windows-x86_64')
}
const candidate = JSON.parse(await readFile('approved/candidate.json', 'utf8'))
await verifyLocalCandidate(candidate, {
  artifactsDir: 'approved/release', repoRoot: resolve('.'), request,
  commit: process.env.SOURCE_COMMIT, sourceTag: process.env.SOURCE_TAG,
})
const storage = createStorage()
for (const entry of candidate.entries) {
  const live = await storage.getJson(`imai-desktop/stable/${entry.target}/${entry.arch}/latest.json`)
  if (live && !(compareReleaseVersions(candidate.version, live.version) > 0 || live.candidate_id === candidate.id)) throw new Error('Candidate must advance the live version or resume the same candidate')
}
console.log(`Verified exact candidate ${candidate.id}; no production writes`)
