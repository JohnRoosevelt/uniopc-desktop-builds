// Exercise the real upload, readback, signature verification and server copy with
// an existing signed Windows installer. All writes stay under benchmarks/; no
// release function, production manifest, alias or promotion lock is touched.
import { mkdtemp, mkdir, copyFile, writeFile, appendFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createStorage, validateCandidate, verifyCandidate, publishCandidate } from './desktop-release-candidate.mjs'
import { readDesktopUpdaterConfs, resolveUpdaterPubkeys } from './check-updater-signing-keys.mjs'

export function isolateBenchmarkStorage(storage, name, measurements = []) {
  if (!/^windows-[a-zA-Z0-9-]+$/.test(name)) throw new Error('Unsafe benchmark name')
  const prefix = `imai-desktop/benchmarks/${name}/`
  const written = new Set()
  const key = value => {
    if (!value.startsWith('imai-desktop/') || value.includes('..')) throw new Error('Unsafe benchmark key')
    return prefix + value
  }
  const measure = async (operation, object, action, bytes = 0) => {
    const start = performance.now()
    try { return await action() }
    finally { measurements.push({ operation, key: object, seconds: (performance.now() - start) / 1000, bytes }) }
  }
  return {
    isTestStorage: true,
    url: value => storage.url(key(value)),
    getJson: value => storage.getJson(key(value)),
    download: (value, destination) => measure('download', value, () => storage.download(key(value), destination)),
    async put(value, options) {
      written.add(key(value))
      const bytes = options.content === undefined ? (await stat(options.filePath)).size : Buffer.byteLength(options.content)
      return measure('upload', value, () => storage.put(key(value), options), bytes)
    },
    async copy(source, destination) {
      written.add(key(destination))
      return measure('copy', destination, () => storage.copy(key(source), key(destination)))
    },
    async remove(value) { await storage.remove(key(value)); written.delete(key(value)) },
    // Record publication is intentionally simulated; no backend write token is
    // loaded by this workflow. The slow storage path is otherwise unchanged.
    async publish() {},
    async cleanup() {
      const failures = []
      for (const value of written) {
        try { await storage.remove(value) } catch { failures.push(value) }
      }
      if (failures.length) throw new Error(`Benchmark cleanup failed for ${failures.length} objects under ${prefix}`)
    },
  }
}

export async function benchmarkPublication(env = process.env) {
  const baselineSeconds = 2541 // previous real publication step: 42m21s
  const storage = createStorage(env)
  const directory = await mkdtemp(join(tmpdir(), 'uniopc-upload-benchmark-'))
  const measurements = []
  const name = `windows-${env.GITHUB_RUN_ID || Date.now()}-${env.GITHUB_RUN_ATTEMPT || 1}`
  const isolated = isolateBenchmarkStorage(storage, name, measurements)
  const report = { baselineSeconds, scope: 'storage publication only; backend row simulated; no build or production changes', sourcePreparationSeconds: 0, publicationSeconds: null, measurements, status: 'running' }
  try {
    const preparation = performance.now()
    const live = await storage.getJson('imai-desktop/stable/windows/x86_64/latest.json')
    if (!live?.candidate_id) throw new Error('No published Windows candidate to benchmark')
    const candidate = await storage.getJson(`imai-desktop/candidates/${live.candidate_id}/candidate.json`)
    validateCandidate(candidate, live.candidate_id)
    if (candidate.targets.length !== 1 || candidate.targets[0] !== 'windows-x86_64' || live.version !== candidate.version) throw new Error('Benchmark requires one matching Windows candidate')
    const keys = Object.fromEntries(Object.entries(resolveUpdaterPubkeys(readDesktopUpdaterConfs(resolve(import.meta.dirname, '..')))).map(([target, entry]) => [target, entry.pubkey]))
    const verified = await verifyCandidate(candidate, { storage, keys, directory })
    const artifactsDir = join(directory, 'release')
    const targetDir = join(artifactsDir, 'windows-x86_64')
    await mkdir(targetDir, { recursive: true })
    const files = new Set()
    for (const entry of candidate.entries) {
      for (const role of ['updater', 'installer', 'signatureFile']) {
        const file = entry[role]
        if (!files.has(file.key)) await copyFile(verified.get(file.key), join(targetDir, file.fileName))
        files.add(file.key)
      }
      await writeFile(join(targetDir, 'signed-build.json'), JSON.stringify(entry.evidence))
    }
    report.sourcePreparationSeconds = (performance.now() - preparation) / 1000
    report.version = candidate.version
    report.sizeBytes = candidate.entries[0].installer.sizeBytes
    const start = performance.now()
    const result = await publishCandidate({ tag: candidate.tag, commit: candidate.commit, runId: candidate.runId, runAttempt: candidate.runAttempt, artifactsDir }, { storage: isolated, keys, expectedVersion: candidate.version })
    report.publicationSeconds = (performance.now() - start) / 1000
    report.status = result.promotion.status
    report.reductionPercent = 100 * (1 - report.publicationSeconds / baselineSeconds)
  } catch (error) {
    report.status = 'failed'
    // Do not record arbitrary transport exception bodies or credentials.
    throw error
  } finally {
    try { await isolated.cleanup(); report.cleanup = 'complete' }
    catch (error) { report.cleanup = 'failed'; throw error }
    finally {
      await rm(directory, { recursive: true, force: true })
      await writeFile('publication-benchmark.json', JSON.stringify(report, null, 2) + '\n')
      if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### Windows publication benchmark\nStatus: ${report.status}\nPrevious publication: ${baselineSeconds}s\nOptimized publication: ${report.publicationSeconds?.toFixed(2) ?? 'failed'}s\nSource preparation (excluded): ${report.sourcePreparationSeconds.toFixed(2)}s\nCleanup: ${report.cleanup}\nProduction unchanged; release database write simulated.\n`)
      console.log(JSON.stringify(report, null, 2))
    }
  }
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) benchmarkPublication().catch(() => { console.error('Publication benchmark failed; inspect transfer timings and cleanup status'); process.exitCode = 1 })
