// Bundle the vendored Cursor++ server + our entry into dist/server.cjs.
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

const VENDOR = path.join(import.meta.dirname, '..', 'vendor', 'CCursor', 'Cursor++')
const vendorModules = path.join(VENDOR, 'node_modules')

// build needs the vendored package's deps just to resolve imports (build-time only)
if (!fs.existsSync(vendorModules)) {
  console.error('[build] vendor deps are missing.')
  console.error('[build] run `npm run bootstrap` first, then build/publish again.')
  process.exit(1)
}

await esbuild.build({
  entryPoints: [path.join(import.meta.dirname, '..', 'src', 'standalone.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(import.meta.dirname, '..', 'dist', 'server.cjs'),
  // no sourcemap: saves ~25MB of build output
  nodePaths: [vendorModules],
  external: ['@vakra-dev/supermarkdown'],
  logLevel: 'info',
})
console.log('[build] dist/server.cjs written')
