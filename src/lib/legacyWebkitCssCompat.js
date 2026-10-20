import postcss from 'postcss'
import nesting from 'postcss-nesting'

export const legacyWebkitMediaQueryPlugin = {
  postcssPlugin: 'legacy-webkit-media-query-compat',
  AtRule(atRule) {
    if (atRule.name !== 'media') return

    atRule.params = atRule.params
      .replace(/\(width\s*>=\s*([^\)]+)\)/g, '(min-width: $1)')
      .replace(/\(width\s*<\s*([^\)]+)\)/g, '(max-width: calc($1 - 0.02px))')
  },
}

// Tailwind v4 nests responsive declarations and emits Media Queries Level 4
// range syntax, for example `(width >= 64rem)`. macOS 12's WKWebView
// (Safari 15) supports neither form. Expand nesting first, then lower the
// two responsive range forms to broadly-supported min/max-width syntax.
export async function lowerLegacyWebkitCss(css) {
  const flattened = await postcss([nesting(), legacyWebkitMediaQueryPlugin]).process(css, { from: undefined })
  return flattened.css
}
