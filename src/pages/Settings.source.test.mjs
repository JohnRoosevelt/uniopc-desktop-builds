import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('settings section navigation stays inside the current settings route scope', () => {
  const source = read('src/pages/Settings.jsx')

  assert.equal(source.includes("import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'"), true)
  assert.equal(source.includes('function settingsSectionPath(pathname = \'\', section = \'general\')'), true)
  assert.equal(source.includes("const profileSettingsMatch = normalizedPath.match(/^(\\/profiles\\/[^/]+\\/settings)(?:\\/[^/]+)?$/)"), true)
  assert.equal(source.includes("return profileSettingsMatch ? `${profileSettingsMatch[1]}/${section}` : `/settings/${section}`"), true)
  assert.equal(source.includes('const location = useLocation()'), true)
  assert.equal(source.includes("to={settingsSectionPath(location.pathname, 'general')}"), true)
  assert.equal(source.includes('const target = settingsSectionPath(location.pathname, section)'), true)
  assert.equal(source.includes("profileWorkspacePath(profileWorkspace, `settings/${section}`)"), false)
})
