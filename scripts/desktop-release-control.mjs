#!/usr/bin/env node
// No browser, GitHub CLI or new API token required: authenticated Git tag pushes
// start the candidate or explicit publication workflows; use the GitHub plugin
// to follow runs and download their private artifacts.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readDesktopReleaseVersion } from './prepare-desktop-updater-release.mjs'
import { planRelease } from './desktop-release-candidate.mjs'
import { verifyPublisherUpdate } from './desktop-candidate-promotion.mjs'

export function validateReleaseOrigin(remote) {
  if (!/^(git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)JohnRoosevelt\/uniopc-desktop-builds(?:\.git)?$/.test(remote)) throw new Error('Release commands require the exact JohnRoosevelt/uniopc-desktop-builds origin')
}

const ROOT = resolve(import.meta.dirname, '..')
export function publicationRequest(candidateId, commit, verifyOnly = false) {
  const match = String(candidateId).match(/^(all|desktop|macos|windows)-v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))-([a-f0-9]{12})-([1-9][0-9]*)-([1-9][0-9]*)$/)
  if (!match || match[1] !== 'windows' || !/^[a-f0-9]{40}$/.test(commit) || !commit.startsWith(match[3])) throw new Error('Provide the exact candidate ID and its full tested commit SHA')
  return { tag: `${verifyOnly ? 'verify-publish' : 'publish'}/${candidateId}`, commit }
}

export function pushTagOnce(tag, commit, git, dryRun = false) {
  const remote = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).trim()
  if (remote) {
    if (remote.split(/\s/)[0] !== commit) throw new Error('Remote tag already points to another commit; refusing to move it')
    return { tag, commit, state: 'already-requested; inspect existing run, do not trigger again' }
  }
  if (dryRun) return { tag, commit, state: 'preview; no tag created or pushed' }
  const local = git(['tag', '--list', tag]).trim()
  if (local) {
    if (git(['rev-parse', `refs/tags/${tag}`]).trim() !== commit) throw new Error('Local tag points to another commit')
  } else git(['tag', tag, commit])
  git(['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
  return { tag, commit, state: 'requested' }
}

async function main(argv) {
  const operation = argv.shift()
  const args = {}
  while (argv.length) {
    const flag = argv.shift()
    if (['--dry-run', '--verify-only'].includes(flag)) args[flag.slice(2)] = true
    else {
      if (!['--platform', '--candidate', '--commit', '--build', '--publisher-commit'].includes(flag) || !argv.length || argv[0].startsWith('--')) throw new Error('Unknown or incomplete option')
      args[flag.slice(2)] = argv.shift()
    }
  }
  const git = values => {
    const r = spawnSync('git', values, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })
    if (r.error || r.status !== 0) throw new Error(`Git ${values[0]} failed; check existing SSH/repository access`)
    return r.stdout
  }
  const remote = git(['remote', 'get-url', 'origin']).trim()
  validateReleaseOrigin(remote)
  let request
  if (operation === 'candidate') {
    if (git(['status', '--porcelain']).trim()) throw new Error('Commit candidate code before requesting a build')
    const platform = args.platform || 'windows'
    if (platform !== 'windows') throw new Error('Public builds support Windows only')
    const version = await readDesktopReleaseVersion()
    const prefix = `test/${platform === 'all' ? '' : platform + '/'}v${version}-`
    const existing = git(['ls-remote', '--tags', 'origin', `refs/tags/${prefix}*`])
    const numbers = existing.split('\n').map(line => Number(line.split(prefix)[1])).filter(Number.isSafeInteger)
    const build = args.build || String(Math.max(0, ...numbers) + 1)
    if (!/^[1-9][0-9]*$/.test(build)) throw new Error('Build number must be positive')
    const tag = prefix + build
    planRelease(tag, version)
    request = { tag, commit: git(['rev-parse', 'HEAD']).trim() }
  } else if (operation === 'publish') {
    const short = String(args.candidate).match(/-([a-f0-9]{12})-[1-9][0-9]*-[1-9][0-9]*$/)?.[1]
    if (!short) throw new Error('Provide the exact candidate ID')
    const commit = args.commit || git(['rev-parse', `${short}^{commit}`]).trim()
    request = publicationRequest(args.candidate, commit, args['verify-only'])
    git(['cat-file', '-e', `${request.commit}^{commit}`])
    if (args['publisher-commit']) {
      const controller = git(['rev-parse', `${args['publisher-commit']}^{commit}`]).trim()
      git(['merge-base', '--is-ancestor', commit, controller])
      const files = git(['diff', '--name-only', commit, controller]).trim().split('\n').filter(Boolean).map(filename => ({ filename }))
      verifyPublisherUpdate(commit, controller, { status: 'ahead', files })
      request.commit = controller
    }
    const publisher = git(['show', `${request.commit}:.github/workflows/desktop-promote.yml`])
    if (!publisher.includes("tags: ['publish/**', 'verify-publish/**']")) throw new Error('Candidate predates the internal publication workflow; generate a new candidate first')
  } else throw new Error('Use candidate --platform windows or publish --candidate ID --commit SHA [--verify-only]')
  console.log(JSON.stringify(pushTagOnce(request.tag, request.commit, git, args['dry-run']), null, 2))
  console.log('Follow the matching tag run with the GitHub plugin; no browser is needed.')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
