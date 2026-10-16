/**
 * Entry point for the vendored Cursor++ server (from the vendor/CCursor submodule).
 * The submodule is patched at bootstrap time (see patches/) so it runs standalone.
 */
import { startServer } from '../vendor/CCursor/Cursor++/src/server/index'

const host = process.env.BYOK_HOST || '127.0.0.1'
const port = Number(process.env.BYOK_PORT || 39831)

startServer({ host, port })
  .then((r) => {
    console.log(`[ccursor-server] listening on http://${r.host}:${r.port}`)
  })
  .catch((err) => {
    console.error('[ccursor-server] failed to start:', err)
    process.exit(1)
  })
