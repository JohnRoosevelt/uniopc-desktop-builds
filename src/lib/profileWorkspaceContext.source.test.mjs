import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('profile workspace preserves organization metadata for current profile settings', () => {
  const source = read('src/hooks/useProfileWorkspace.jsx')

  assert.match(source, /const operatorOrganizationName = clean\(workspaceProfile\?\.organizationName\s*\|\|\s*workspaceProfile\?\.organization_name\)/)
  assert.match(source, /const operatorOrganizationTypeId = clean\(workspaceProfile\?\.organizationTypeId\s*\|\|\s*workspaceProfile\?\.organization_type_id\)/)
  assert.match(source, /const operatorOrganizationTypeName = clean\(workspaceProfile\?\.organizationTypeName\s*\|\|\s*workspaceProfile\?\.organization_type_name\)/)
  assert.match(source, /organizationName:\s*operatorOrganizationName/)
  assert.match(source, /organizationTypeId:\s*operatorOrganizationTypeId/)
  assert.match(source, /organizationTypeName:\s*operatorOrganizationTypeName/)
})
