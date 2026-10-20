import { parse } from '@babel/parser'
import { lstat, mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const PACKAGES = new Set(['ai', 'fs-safe', 'proxyline'])
const SPECIFIER = /^@openclaw\/(ai|fs-safe|proxyline)(?=\/|$)/
const DEPS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
function branded(specifier) { return specifier.replace(SPECIFIER, '@uniopc/$1') }
function portableBasename(path) { return path.replaceAll('\\', '/').split('/').at(-1) }

export function managedRuntimeFileKind(path) {
  if (portableBasename(path) === 'package.json') return 'package'
  return /\.(?:[cm]?js|[cm]?ts)$/.test(path) ? 'module' : null
}

// Only module-resolution syntax is changed. Comments, messages, registry URLs,
// protocol symbols and unrelated plugin identities are deliberately untouched.
export function rebrandManagedModuleSpecifiers(source, filename = 'runtime.js') {
  if (!SPECIFIER.test(source) && !/@openclaw\/(?:ai|fs-safe|proxyline)(?:\/|["'`])/.test(source)) return source
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript'], allowUndeclaredExports: true, allowReturnOutsideFunction: true })
  const edits = []
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'StringLiteral' && SPECIFIER.test(node.value)) {
      const moduleSource = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'TSExternalModuleReference', 'TSImportType', 'ImportExpression'].includes(parent?.type)
      const callSource = parent?.type === 'CallExpression' && parent.arguments[0] === node && (
        parent.callee.type === 'Import' || parent.callee.name === 'require' ||
        (parent.callee.type === 'MemberExpression' && parent.callee.property.name === 'resolve' && (parent.callee.object.name === 'require' || parent.callee.object.type === 'MetaProperty')) ||
        (parent.callee.type === 'CallExpression' && (parent.callee.callee.name === 'createRequire' || parent.callee.callee.property?.name === 'createRequire')))
      const coreAlias = /^plugin-module-loader-cache-[^/]+\.js$/.test(portableBasename(filename)) && parent?.type === 'ObjectProperty' && parent.key.name === 'packageName'
      if (moduleSource || callSource || coreAlias) edits.push({ start: node.start, end: node.end, value: JSON.stringify(branded(node.value)) })
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'extra', 'comments', 'tokens'].includes(key)) continue
      if (Array.isArray(value)) for (const item of value) visit(item, node)
      else if (value && typeof value === 'object') visit(value, node)
    }
  }
  visit(ast)
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end)
  return source
}

function rebrandPackageMetadata(manifest) {
  if (typeof manifest.name === 'string') manifest.name = branded(manifest.name)
  for (const field of DEPS) {
    if (!manifest[field]) continue
    for (const [name, spec] of Object.entries(manifest[field])) {
      const next = branded(name)
      if (next === name) continue
      if (Object.hasOwn(manifest[field], next)) throw new Error(`Runtime dependency rename collision: ${name} / ${next}`)
      // Keep the immutable upstream registry source, while npm installs the
      // alias into the branded directory on any subsequent managed install.
      manifest[field][next] = typeof spec === 'string' && !spec.startsWith('npm:') ? `npm:${name}@${spec}` : spec
      delete manifest[field][name]
      if (field === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]) {
        manifest.peerDependenciesMeta[next] = manifest.peerDependenciesMeta[name]
        delete manifest.peerDependenciesMeta[name]
      }
    }
  }
  return manifest
}

// Call only on a private runtime staging tree, never on user plugin directories.
// Prepare every edit and reject collisions/symlinks before making any changes.
export async function rebrandManagedRuntimeScopes(packageRoot) {
  const files = [], moves = [], scopes = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        if (portableBasename(directory) === 'node_modules' && ['@openclaw', '@uniopc'].includes(entry.name)) throw new Error(`Managed runtime scope symlink: ${path}`)
        continue
      }
      if (entry.isDirectory()) {
        if (entry.name === '@openclaw' && portableBasename(directory) === 'node_modules') {
          scopes.push(path)
          for (const child of await readdir(path, { withFileTypes: true })) {
            if (!PACKAGES.has(child.name) || !child.isDirectory()) throw new Error(`Unsupported managed runtime scope entry: ${join(path, child.name)}`)
            const target = join(directory, '@uniopc', child.name)
            if (await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error(`Runtime scope rename collision: ${target}`)
            const metadata = JSON.parse(await readFile(join(path, child.name, 'package.json'), 'utf8'))
            if (metadata.name !== `@openclaw/${child.name}`) throw new Error(`Unexpected managed package identity: ${metadata.name}`)
            moves.push([join(path, child.name), target])
          }
        }
        await walk(path)
      } else if (entry.isFile()) files.push(path)
    }
  }
  await walk(packageRoot)
  const edits = []
  for (const path of files) {
    const kind = managedRuntimeFileKind(path)
    if (!kind) continue
    const before = await readFile(path, 'utf8')
    let after = before
    if (kind === 'package') {
      const parsed = JSON.parse(before)
      const original = JSON.stringify(parsed)
      rebrandPackageMetadata(parsed)
      if (JSON.stringify(parsed) !== original) after = JSON.stringify(parsed, null, 2) + '\n'
    } else after = rebrandManagedModuleSpecifiers(before, path)
    if (before !== after) edits.push([path, after])
  }
  for (const [path, source] of edits) await writeFile(path, source)
  for (const [source, target] of moves) { await mkdir(dirname(target), { recursive: true }); await rename(source, target) }
  for (const scope of scopes) await rmdir(scope)
  return { renamed: moves.length, patched: edits.length }
}
