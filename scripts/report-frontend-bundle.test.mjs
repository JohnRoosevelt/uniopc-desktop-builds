import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeManifest } from './report-frontend-bundle.mjs'

test('summarizeManifest orders emitted chunks by byte size and preserves dynamic imports', () => {
  const rows = summarizeManifest(
    {
      'src/main.jsx': {
        file: 'assets/main.js',
        imports: ['assets/vendor.js'],
        dynamicImports: ['src/pages/Employees.jsx'],
      },
      'src/pages/Employees.jsx': { file: 'assets/employees.js' },
    },
    { 'assets/main.js': 120, 'assets/employees.js': 240 },
  )

  assert.deepEqual(rows, [
    { file: 'assets/employees.js', bytes: 240, imports: [], dynamicImports: [] },
    {
      file: 'assets/main.js',
      bytes: 120,
      imports: ['assets/vendor.js'],
      dynamicImports: ['src/pages/Employees.jsx'],
    },
  ])
})
