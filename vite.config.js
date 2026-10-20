import { defineConfig, transformWithEsbuild } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin'
import { fileURLToPath } from 'node:url'
import nesting from 'postcss-nesting'
import { legacyWebkitMediaQueryPlugin } from './src/lib/legacyWebkitCssCompat.js'

const blocksuiteIconsLit = fileURLToPath(new URL('./src/lib/blocksuiteIconsLitCompat.js', import.meta.url))
const blocksuiteBlocksCompat = fileURLToPath(new URL('./src/lib/blocksuiteBlocksCompat.js', import.meta.url))
const blocksuiteIconsRc = fileURLToPath(new URL('./node_modules/@blocksuite/icons/dist/rc.mjs', import.meta.url))
const blocksuiteBlocksMarkdown = fileURLToPath(
  new URL('./node_modules/@blocksuite/blocks/dist/_common/adapters/markdown/index.js', import.meta.url),
)
const blocksuitePresetsPageEditor = fileURLToPath(
  new URL('./node_modules/@blocksuite/presets/dist/editors/page-editor.js', import.meta.url),
)
const blocksuitePresetsHelpers = fileURLToPath(
  new URL('./node_modules/@blocksuite/presets/dist/helpers/index.js', import.meta.url),
)
const blocksuiteAffineShared = fileURLToPath(
  new URL('./node_modules/@blocksuite/affine-shared', import.meta.url),
)
const blocksuiteAffineComponents = fileURLToPath(
  new URL('./node_modules/@blocksuite/affine-components', import.meta.url),
)
const blocksuiteAffineBlockSurface = fileURLToPath(
  new URL('./node_modules/@blocksuite/affine-block-surface', import.meta.url),
)
const yjs = fileURLToPath(new URL('./node_modules/yjs', import.meta.url))
const blocksuiteAffineSharedExports = {
  '@blocksuite/affine-shared/selection': `${blocksuiteAffineShared}/src/selection/index.ts`,
  '@blocksuite/affine-shared/utils': `${blocksuiteAffineShared}/src/utils/index.ts`,
  '@blocksuite/affine-shared/consts': `${blocksuiteAffineShared}/src/consts/index.ts`,
  '@blocksuite/affine-shared/types': `${blocksuiteAffineShared}/src/types/index.ts`,
  '@blocksuite/affine-shared/commands': `${blocksuiteAffineShared}/src/commands/index.ts`,
  '@blocksuite/affine-shared/theme': `${blocksuiteAffineShared}/src/theme/index.ts`,
  '@blocksuite/affine-shared/styles': `${blocksuiteAffineShared}/src/styles/index.ts`,
  '@blocksuite/affine-shared/services': `${blocksuiteAffineShared}/src/services/index.ts`,
  '@blocksuite/affine-shared/adapters': `${blocksuiteAffineShared}/src/adapters/index.ts`,
  '@blocksuite/affine-shared': `${blocksuiteAffineShared}/src/index.ts`,
}
const blocksuiteComponentAliases = [
  {
    find: /^@blocksuite\/affine-components$/,
    replacement: `${blocksuiteAffineComponents}/src/index.ts`,
  },
  {
    find: /^@blocksuite\/affine-components\/(.+)$/,
    replacement: `${blocksuiteAffineComponents}/src/$1/index.ts`,
  },
]
const blocksuiteSurfaceAliases = [
  {
    find: /^@blocksuite\/affine-block-surface$/,
    replacement: `${blocksuiteAffineBlockSurface}/src/index.ts`,
  },
  {
    find: /^@blocksuite\/affine-block-surface\/(.+)$/,
    replacement: `${blocksuiteAffineBlockSurface}/src/$1.ts`,
  },
]
const dotLottieWc = fileURLToPath(
  new URL('./node_modules/@lottiefiles/dotlottie-wc/dist/index.js', import.meta.url),
)
const blocksuiteCommonJsDeps = [
  'lodash.chunk',
  'lodash.clonedeep',
  'lodash.ismatch',
  'lodash.merge',
  'lodash.mergewith',
  'extend',
  'debug',
  'picocolors',
  'deepmerge',
  // 少了这一项,dev 下编辑器复制会静默失效:@blocksuite/* 被 optimizeDeps.exclude
  // 排除后,它们 import 的 lz-string 不会被预打包,Vite 把这个 UMD 原样发给浏览器 ——
  // ES module 里 typeof module === 'undefined',三个分支全不成立,于是零导出。
  // block-std 的 writeToClipboard 调 lz.compressToEncodedURIComponent 就抛 TypeError,
  // 而 onPageCopy 已经先 preventDefault() 掐了原生复制,结果是剪贴板一片空白且无报错。
  'lz-string',
]
const blocksuiteSingletonDeps = [
  '@blocksuite/affine-block-surface',
  '@blocksuite/affine-components',
  '@blocksuite/affine-shared',
  '@blocksuite/global',
  '@blocksuite/std',
  '@blocksuite/store',
  '@lit/context',
  '@lit/reactive-element',
  '@lottiefiles/dotlottie-wc',
  'lit',
  'lit-element',
  'lit-html',
  'yjs',
]
const blocksuiteNoOptimizeDeps = [
  '@blocksuite/block-std',
  '@blocksuite/blocks',
  '@blocksuite/data-view',
  '@blocksuite/affine-shared',
  '@blocksuite/global',
  '@blocksuite/inline',
  '@blocksuite/presets',
  'yjs',
]

function blocksuiteLegacyWebkitCompat() {
  return {
    name: 'blocksuite-legacy-webkit-compat',
    enforce: 'pre',
    async transform(code, id) {
      const [validId] = id.split('?')
      const isBlocksuiteModule = validId.includes('/node_modules/@blocksuite/')
      const isSupportedSource = /\.(?:[cm]?js|ts)$/.test(validId)
      if (!isBlocksuiteModule || !isSupportedSource || validId.endsWith('.css.ts')) {
        return null
      }
      return transformWithEsbuild(code, validId, {
        loader: validId.endsWith('.ts') ? 'ts' : 'js',
        // macOS 12 ships an older WKWebView that cannot parse class static
        // initialization blocks emitted by BlockSuite's published packages.
        target: 'safari15',
        tsconfigRaw: {
          compilerOptions: {
            useDefineForClassFields: false,
          },
        },
      })
    },
  }
}

function legacyWebkitRegexCompat() {
  return {
    name: 'legacy-webkit-regex-compat',
    enforce: 'pre',
    transform(code, id) {
      const [validId] = id.split('?')
      if (!validId.endsWith('/node_modules/mdast-util-gfm-autolink-literal/lib/index.js')) {
        return null
      }

      // Safari 15 does not support regular-expression lookbehind. The module's
      // findEmail callback already validates the preceding character, so the
      // assertion is redundant here.
      return {
        code: code.replace('(?<=^|\\s|\\p{P}|\\p{S})', ''),
        map: null,
      }
    },
  }
}

export default defineConfig(({ command }) => ({
  plugins: [
    vanillaExtractPlugin(command === 'serve' ? { unstable_mode: 'transform' } : undefined),
    blocksuiteLegacyWebkitCompat(),
    legacyWebkitRegexCompat(),
    react(),
    tailwindcss(),
  ],
  css: {
    postcss: {
      plugins: [nesting(), legacyWebkitMediaQueryPlugin],
    },
  },
  clearScreen: false,
  resolve: {
    alias: [
      {
        find: '@blocksuite/icons/lit',
        replacement: blocksuiteIconsLit,
      },
      {
        find: '@blocksuite/icons/rc',
        replacement: blocksuiteIconsRc,
      },
      {
        find: '@blocksuite/blocks/_common/adapters/markdown',
        replacement: blocksuiteBlocksMarkdown,
      },
      {
        find: '@blocksuite/presets/editors/page-editor',
        replacement: blocksuitePresetsPageEditor,
      },
      {
        find: '@blocksuite/presets/helpers',
        replacement: blocksuitePresetsHelpers,
      },
      {
        find: /^@blocksuite\/blocks$/,
        replacement: blocksuiteBlocksCompat,
      },
      ...blocksuiteComponentAliases,
      ...blocksuiteSurfaceAliases,
      ...Object.entries(blocksuiteAffineSharedExports).map(([find, replacement]) => ({
        find,
        replacement,
      })),
      {
        find: '@lottiefiles/dotlottie-wc',
        replacement: dotLottieWc,
      },
      {
        find: 'yjs',
        replacement: yjs,
      },
    ],
    dedupe: blocksuiteSingletonDeps,
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'safari15',
    outDir: 'dist',
    manifest: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./index.html', import.meta.url)),
    },
  },
  optimizeDeps: {
    include: blocksuiteCommonJsDeps,
    needsInterop: blocksuiteCommonJsDeps,
    exclude: [
      '@blocksuite/affine',
      '@blocksuite/affine/blocks/database',
      '@blocksuite/affine/ext-loader',
      '@blocksuite/affine/extensions/store',
      '@blocksuite/affine/extensions/view',
      '@blocksuite/affine/schemas',
      '@blocksuite/affine/shared/adapters',
      '@blocksuite/affine/std',
      '@blocksuite/affine-block-surface',
      '@blocksuite/affine-components',
      ...blocksuiteNoOptimizeDeps,
      '@blocksuite/store',
      '@blocksuite/store/test',
      'remark-gfm',
      'mdast-util-gfm-autolink-literal',
    ],
  },
  envPrefix: ['VITE_', 'TAURI_'],
}))
