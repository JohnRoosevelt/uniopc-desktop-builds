import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebrandRuntimeTree } from './uniopc-runtime-branding.mjs'
import { isManagedSkillMarkdown, rebrandSkillMarkdown, skillBrandOccurrences } from './uniopc-skill-branding.mjs'

const protectedText = [
  'openclaw security audit --deep',
  '`openclaw security audit --deep`',
  'https://docs.openclaw.ai',
  'https://github.com/OpenClaw/example',
  '@openclaw/ai OPENCLAW_STATE_DIR OpenClawConfig',
  'Copyright (c) 2026 OpenClaw Foundation',
  '```sh\nOpenClaw OPENCLAW 小龙虾\n```',
  '    OpenClaw indented code',
  '`OpenClaw` and ``OpenClaw ` example``',
  '<https://github.com/OpenClaw/example>',
  '[docs](../OpenClaw/example_(test) "OpenClaw title")',
  '[docs]: ../OpenClaw/example "OpenClaw title"',
].join('\n')
const original = `---\nname: OpenClaw\ndescription: "Audit/harden OpenClaw hosts..."\nhomepage: https://github.com/OpenClaw/example\nlicense: OpenClaw\nmetadata: { product: OpenClaw }\n---\n# OpenClaw host healthcheck\nNever claim OpenClaw manages OS firewall\nOpenClaw also supports \`metadata\`\nOPENCLAW and 小龙虾\n[OpenClaw](https://github.com/OpenClaw/example)\n${protectedText}\n`

test('Skill prose transforms without changing frontmatter, code, URLs, destinations or attribution', () => {
  const result = rebrandSkillMarkdown(original)
  assert.equal(skillBrandOccurrences(original).length, 7)
  assert.equal(result, original
    .replace('Audit/harden OpenClaw', 'Audit/harden Uniopc')
    .replace('# OpenClaw', '# Uniopc')
    .replace('claim OpenClaw', 'claim Uniopc')
    .replace('OpenClaw also', 'Uniopc also')
    .replace('OPENCLAW and 小龙虾', 'Uniopc and Uniopc')
    .replace('[OpenClaw]', '[Uniopc]'))
  assert.ok(result.includes(protectedText))
  assert.equal(rebrandSkillMarkdown(result), result)
  assert.deepEqual(skillBrandOccurrences(result), [])
})

test('frontmatter block descriptions retain formatting and unsupported syntax fails clearly', () => {
  assert.equal(rebrandSkillMarkdown('---\ndescription: >-\n  OpenClaw hosts\nmetadata:\n  label: OpenClaw\n---\nOpenClaw\n'),
    '---\ndescription: >-\n  Uniopc hosts\nmetadata:\n  label: OpenClaw\n---\nUniopc\n')
  for (const source of ['---\ndescription: OpenClaw', '---\ndescription: {text: OpenClaw}\n---\n', '---\ndescription: "OpenClaw\n  hosts"\n---\n', '---\n{description: OpenClaw}\n---\n']) {
    assert.throws(() => rebrandSkillMarkdown(source), /Unsafe Skill frontmatter/)
  }
})

test('runtime tree changes only managed skill Markdown and is idempotent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'uniopc-skill-brand-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of ['skills/healthcheck/SKILL.md', 'skills/healthcheck/references/help.md', 'skills/healthcheck/run.sh', 'skills/healthcheck/LICENSE.md', 'skills/healthcheck/THIRD_PARTY.md', 'skills/healthcheck/node_modules/demo/SKILL.md', 'node_modules/demo/skills/SKILL.md', 'extensions/demo/skills/SKILL.md']) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), original)
  }
  assert.deepEqual((await rebrandRuntimeTree(root)).sort(), [join(root, 'skills/healthcheck/SKILL.md'), join(root, 'skills/healthcheck/references/help.md')].sort())
  for (const path of ['skills/healthcheck/run.sh', 'skills/healthcheck/LICENSE.md', 'skills/healthcheck/THIRD_PARTY.md', 'skills/healthcheck/node_modules/demo/SKILL.md', 'node_modules/demo/skills/SKILL.md', 'extensions/demo/skills/SKILL.md']) {
    assert.equal(await readFile(join(root, path), 'utf8'), original)
    assert.equal(isManagedSkillMarkdown(path), false)
  }
  assert.deepEqual(await rebrandRuntimeTree(root), [])
})

test('reference labels change while identifiers and implicit reference labels remain intact', () => {
  const source = '[OpenClaw][OpenClaw]\n[OpenClaw][]\n[OpenClaw]\n\n[OpenClaw]: https://example.org\n'
  assert.equal(rebrandSkillMarkdown(source), '[Uniopc][OpenClaw]\n[OpenClaw][]\n[OpenClaw]\n\n[OpenClaw]: https://example.org\n')
})

test('link-like code and incomplete links cannot conceal subsequent prose', () => {
  for (const source of ['`](example`\nOpenClaw prose', '[label](incomplete\nOpenClaw prose', '```\n[label](incomplete\n```\nOpenClaw prose']) {
    assert.equal(rebrandSkillMarkdown(source), source.replace('OpenClaw prose', 'Uniopc prose'))
    assert.equal(skillBrandOccurrences(source).length, 1)
  }
})

test('standalone brands inside technical package and path tokens stay unchanged', () => {
  const source = 'Install OpenClaw/plugin and OpenClaw-cli. OpenClaw hosts use @OpenClaw/sdk and /opt/OpenClaw/bin.'
  assert.equal(rebrandSkillMarkdown(source), source.replace('OpenClaw hosts', 'Uniopc hosts'))
})

test('non-string description mappings, sequences and typed scalars fail explicitly', () => {
  for (const description of ['', '\n  product: OpenClaw', '\n  - OpenClaw', '[OpenClaw]', '{product: OpenClaw}', 'true', '42', 'null']) {
    assert.throws(() => rebrandSkillMarkdown(`---\ndescription: ${description}\n---\n`), /Unsafe Skill frontmatter/)
  }
})
