#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { planRelease } from './desktop-release-candidate.mjs'
import { parsePromotionTag } from './desktop-candidate-promotion.mjs'

export const PUBLIC_REPOSITORY = 'JohnRoosevelt/uniopc-desktop-builds'
export function validatePublicContext(env, operation) {
  if (env.GITHUB_REPOSITORY !== PUBLIC_REPOSITORY || env.GITHUB_ACTOR !== 'JohnRoosevelt' || env.GITHUB_TRIGGERING_ACTOR !== 'JohnRoosevelt') throw new Error('Public release requires the exact repository and owner actors')
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('Invalid release commit')
  if (operation === 'warm') {
    if (!['workflow_dispatch', 'push'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Cache preparation requires owner main push or manual main')
  } else {
    if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== `refs/tags/${env.GITHUB_REF_NAME}`) throw new Error('Release requires a pushed tag')
    if (operation === 'candidate') {
      if (!/^test\/windows\/v\d+\.\d+\.\d+-[1-9]\d*$/.test(env.GITHUB_REF_NAME)) throw new Error('Only test/windows candidate tags are supported')
      planRelease(env.GITHUB_REF_NAME)
    } else if (operation === 'runtime-probe') {
      if (!/^test\/runtime-cache\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(env.GITHUB_REF_NAME)) throw new Error('Runtime probe requires a test/runtime-cache tag')
    } else if (operation === 'promotion') {
      if (!parsePromotionTag(env.GITHUB_REF_NAME).candidateId.startsWith('windows-')) throw new Error('Only Windows publication is supported')
    } else throw new Error('Unknown public release operation')
  }
}
export function guardPublicRelease(operation, env = process.env, git = args => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })) {
  validatePublicContext(env, operation)
  git(['merge-base', '--is-ancestor', env.GITHUB_SHA, 'refs/remotes/origin/main'])
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { guardPublicRelease(process.argv[2]); console.log('Owner, tag and main ancestry verified') }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
