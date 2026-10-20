import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('skills are managed from AI employees instead of a standalone skill market', () => {
  const app = read('src/App.jsx')
  const layout = read('src/components/Layout.jsx')
  const employees = read('src/pages/Employees.jsx')

  assert.equal(app.includes("import Skillhub from './pages/Skillhub'"), false)
  assert.equal(layout.includes("to: '/skillhub'"), false)
  assert.equal(layout.includes("pathname.startsWith('/skillhub')"), false)
  assert.equal(employees.includes("navigate('/skillhub')"), false)
  assert.equal(employees.includes('技能市场'), false)
})
