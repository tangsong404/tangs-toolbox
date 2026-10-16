// One command to get from a fresh checkout to a runnable server:
//   0. root deps (esbuild, for our build script)
//   1. vendored CCursor submodule at the pinned commit
//   2. the vendored package's production deps (build-time only)
//   3. our patches (patches/*.patch) applied to the submodule
//   4. build -> dist/server.cjs
//
// Proxy: set BYOK_PROXY (or HTTPS_PROXY) if GitHub/npm needs a proxy,
// e.g.  set BYOK_PROXY=http://127.0.0.1:7890
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const SUB = path.join(ROOT, 'vendor', 'CCursor')
const VENDOR_PKG = path.join(SUB, 'Cursor++')
const PATCH_DIR = path.join(ROOT, 'patches')

const proxy = process.env.BYOK_PROXY || process.env.HTTPS_PROXY || ''
const env = { ...process.env }
if (proxy) {
  env.HTTPS_PROXY = env.HTTP_PROXY = env.ALL_PROXY = proxy
  console.log(`[bootstrap] using proxy ${proxy}`)
}

function run(cmd, args, opts = {}) {
  console.log(`[bootstrap] $ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, cwd: ROOT, shell: process.platform === 'win32', ...opts })
  if (r.status !== 0) {
    console.error(`[bootstrap] failed (${r.status}): ${cmd} ${args.join(' ')}`)
    process.exit(r.status || 1)
  }
}

// 0. root deps (our build script needs esbuild)
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'esbuild'))) {
  run('npm', ['install', '--no-audit', '--no-fund'])
}
else {
  console.log('[bootstrap] root deps present')
}

// 1. submodule (shallow, pinned by the superproject)
run('git', ['submodule', 'update', '--init', '--recursive', 'vendor/CCursor'])

// 2. vendored package's production deps (build-time only)
if (!fs.existsSync(path.join(VENDOR_PKG, 'node_modules'))) {
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: VENDOR_PKG })
}
else {
  console.log('[bootstrap] vendor deps present')
}

// 3. patches
const patches = fs.existsSync(PATCH_DIR) ? fs.readdirSync(PATCH_DIR).filter(f => f.endsWith('.patch')).sort() : []
for (const p of patches) {
  const abs = path.join(PATCH_DIR, p)
  const check = spawnSync('git', ['-C', SUB, 'apply', '--check', abs], { env, stdio: 'pipe', shell: process.platform === 'win32' })
  if (check.status === 0) {
    run('git', ['-C', SUB, 'apply', abs])
    console.log(`[bootstrap] applied ${p}`)
  }
  else {
    console.log(`[bootstrap] ${p} already applied (or conflicts) — skipping`)
  }
}

// 4. build
run(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { shell: false })

console.log('\n[bootstrap] done — dist/server.cjs is ready.')
console.log('  npm run cli      # TUI: start the service, configure providers')
