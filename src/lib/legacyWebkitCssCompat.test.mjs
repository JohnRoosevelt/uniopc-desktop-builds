import assert from 'node:assert/strict'
import test from 'node:test'

import { lowerLegacyWebkitCss } from './legacyWebkitCssCompat.js'

test('lowers Tailwind nested range media queries for Safari 15', async () => {
  const css = await lowerLegacyWebkitCss(`
    .lg\\:grid { @media (width >= 64rem) { display: grid; } }
    .max-lg\\:hidden { @media (width < 64rem) { display: none; } }
  `)

  assert.match(css, /@media \(min-width: 64rem\)\s*\{\s*\.lg\\:grid\s*\{/)
  assert.match(css, /@media \(max-width: calc\(64rem - 0\.02px\)\)\s*\{\s*\.max-lg\\:hidden\s*\{/)
  assert.doesNotMatch(css, /\(width\s*(?:>=|<)\s*64rem\)/)
  assert.doesNotMatch(css, /\.lg\\:grid\s*\{\s*@media/)
})

test('leaves unrelated modern CSS untouched', async () => {
  const css = '@media (prefers-reduced-motion: reduce) { .motion-safe { animation: none; } }'

  assert.equal(await lowerLegacyWebkitCss(css), css)
})
