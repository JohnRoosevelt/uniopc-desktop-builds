import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const desktopRoot = path.resolve(path.dirname(scriptPath), '..')
const distDir = path.join(desktopRoot, 'dist')
const manifestPath = path.join(distDir, '.vite', 'manifest.json')

export function summarizeManifest(manifest, sizes) {
  return Object.values(manifest)
    .filter(entry => entry.file)
    .map(entry => ({
      file: entry.file,
      bytes: sizes[entry.file] ?? 0,
      imports: entry.imports ?? [],
      dynamicImports: entry.dynamicImports ?? [],
    }))
    .sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file))
}

async function readChunkSizes(manifest) {
  const files = [...new Set(Object.values(manifest).map(entry => entry.file).filter(Boolean))]
  const entries = await Promise.all(
    files.map(async file => [file, (await stat(path.join(distDir, file))).size]),
  )
  return Object.fromEntries(entries)
}

export async function reportFrontendBundle() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const chunks = summarizeManifest(manifest, await readChunkSizes(manifest)).slice(0, 10)

  console.log('Largest frontend bundle chunks:')
  for (const chunk of chunks) {
    console.log(`- ${chunk.file}: ${chunk.bytes} bytes`)
    console.log(`  dynamic imports: ${chunk.dynamicImports.join(', ') || '(none)'}`)
  }
}

if (process.argv[1] === scriptPath) {
  await reportFrontendBundle()
}
