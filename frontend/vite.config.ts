/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split stable third-party libraries into their own chunks so the main
        // app chunk stays small and vendor code stays cached across app-only
        // deploys. Vite 8 bundles with Rolldown, whose manualChunks only
        // supports the function form (the object/record form Rollup accepted
        // throws "manualChunks is not a function"), so we match modules by the
        // package that owns them. react-markdown drags in a big micromark/mdast
        // subtree, so we list those package-name prefixes explicitly to land
        // the whole tree in the markdown chunk. Anything unmatched falls through
        // to default chunking — notably xlsx, which is dynamically imported and
        // must stay its own lazy chunk (returning a name here would force it
        // eager).
        manualChunks(id) {
          const match = id.match(/[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/)
          if (!match) return
          const pkg = match[1]
          if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') {
            return 'react'
          }
          if (pkg === 'flatpickr') {
            return 'flatpickr'
          }
          const markdownPrefixes = [
            'react-markdown', 'remark-', 'micromark', 'mdast-', 'hast-',
            'unist-', 'unified', 'vfile', 'property-information',
            'space-separated-tokens', 'comma-separated-tokens',
            'character-entities', 'character-reference-invalid',
            'decode-named-character-reference', 'parse-entities',
            'stringify-entities', 'is-alphabetical', 'is-alphanumerical',
            'is-decimal', 'is-hexadecimal', 'is-plain-obj', 'bail', 'ccount',
            'devlop', 'escape-string-regexp', 'estree-util-',
            'html-url-attributes', 'longest-streak', 'markdown-table',
            'style-to-js', 'style-to-object', 'inline-style-parser',
            'trim-lines', 'trough', 'zwitch',
          ]
          if (markdownPrefixes.some((p) => pkg === p || pkg.startsWith(p))) {
            return 'markdown'
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        // Keep the browser's own Host header on proxied requests. The Go
        // server's same-origin CSRF check compares the Origin header against
        // Host, so rewriting Host to localhost:8080 would 403 every mutating
        // request in dev.
        changeOrigin: false,
      },
    },
    fs: {
      allow: [
        path.resolve(import.meta.dirname, '..'),
        path.resolve(import.meta.dirname, '../..'),
      ],
    },
  },
  test: {
    // Vitest config — node environment is sufficient since dealPromptYaml.ts
    // is pure data transformation with no DOM dependencies. Specifying it
    // explicitly so future component tests pick a different env (jsdom) per
    // file rather than slowing down the prompt-generation suite.
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
