import { readFile } from 'node:fs/promises'

// Evaluate the real ES module with only its platform dependencies substituted.
let sequence = 0
export async function loadModule(url, dependencies = {}) {
  let source = await readFile(url, 'utf8')
  for (const [specifier, exports] of Object.entries(dependencies)) {
    const key = `__module_test_${process.pid}_${sequence++}`
    globalThis[key] = exports
    const stub = `const values = globalThis[${JSON.stringify(key)}]; delete globalThis[${JSON.stringify(key)}];\n`
      + Object.keys(exports).map(name => `export const ${name} = values[${JSON.stringify(name)}];`).join('\n')
    const dependencyUrl = `data:text/javascript;base64,${Buffer.from(stub).toString('base64')}`
    source = source.replaceAll(`'${specifier}'`, JSON.stringify(dependencyUrl))
  }
  return import(`data:text/javascript;base64,${Buffer.from(source + `\n// evaluation ${sequence++}`).toString('base64')}`)
}

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
