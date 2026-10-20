#!/usr/bin/env node
// Pure-JS dependencies are built on CI, not downloaded during a user's login.
import { build } from 'esbuild'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, readFile, copyFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
export const presentationsRoot = resolve(root, 'src-tauri/resources/plugins/uniopc/uniopc-presentations')

export async function prepareBundledPluginDependencies({ pluginRoot = presentationsRoot } = {}) {
  const pkg = JSON.parse(await readFile(resolve(root, 'node_modules/pptxgenjs/package.json'), 'utf8'))
  if (pkg.version !== '4.0.1') throw new Error('Unexpected bundled pptxgenjs version')
  const outdir = resolve(pluginRoot, 'lib')
  await mkdir(outdir, { recursive: true })
  const result = await build({
    entryPoints: [require.resolve('pptxgenjs')],
    outfile: resolve(outdir, 'pptxgenjs.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    metafile: true, legalComments: 'inline',
  })
  for (const output of Object.values(result.metafile.outputs)) {
    for (const item of output.imports) {
      if (item.external && !isBuiltin(item.path)) {
        throw new Error(`PPT bundle still requires an unshipped module: ${item.path}`)
      }
    }
  }
  await copyFile(resolve(root, 'node_modules/pptxgenjs/LICENSE'), resolve(outdir, 'pptxgenjs.LICENSE'))
  return resolve(outdir, 'pptxgenjs.cjs')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareBundledPluginDependencies().then(path => console.log(`Prepared offline PPT dependency: ${path}`))
    .catch(error => { console.error(error); process.exitCode = 1 })
}
