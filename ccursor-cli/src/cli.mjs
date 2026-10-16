// ccursor-cli — lightweight TUI to manage the vendored BYOK daemon and its providers.
//
//   - start / stop / restart the daemon (detached, keeps running after this CLI exits)
//   - add / sync / delete providers and their models
//   - tail the daemon log, run cursor-agent, show status
//
// Server: the built vendored CCursor server (dist/server.cjs).
// Providers: ~/.ccursor/providers.json (CCursor format).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'

const DIR = import.meta.dirname          // src/
const SERVER = path.join(DIR, '..', 'dist', 'server.cjs')
// runtime state lives in the user's home so it works the same from a repo, a global
// install, or `npx` (the package dir may be read-only / shared)
const STATE_DIR = path.join(os.homedir(), '.cursor-byok')
const CONFIG = path.join(os.homedir(), '.ccursor', 'providers.json')
const PID_FILE = path.join(STATE_DIR, 'server.pid')
const LOG_DIR = path.join(STATE_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'server.log')
fs.mkdirSync(LOG_DIR, { recursive: true })
fs.mkdirSync(path.dirname(CONFIG), { recursive: true })

const ESC = '\x1b['
const c = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`,
  green: `${ESC}32m`, red: `${ESC}31m`, yellow: `${ESC}33m`, cyan: `${ESC}36m`, gray: `${ESC}90m`,
}

// ── config (~/.ccursor/providers.json, CCursor format) ──
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } catch { return { $schemaVersion: 1, providers: [] } }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2)) }
const allModels = cfg => (cfg.providers ?? []).flatMap(p => (p.models ?? []).map(m => ({ ...m, providerId: p.id, providerName: p.name })))
const providerBase = p => p.baseUrl ?? ''
const providerKey = p => p.auth?.value ?? p.apiKey ?? ''

// ── model discovery ──
const sanitizeId = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
async function fetchUpstreamModels(p) {
  const base = providerBase(p).replace(/\/$/, '')
  const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${providerKey(p)}` } })
  if (!res.ok) throw new Error(`${p.id}: /models ${res.status}`)
  const json = await res.json()
  const list = Array.isArray(json) ? json : (json.data ?? json.models ?? [])
  return list.map(m => ({
    apiModel: m.id ?? m.model ?? m.slug,
    displayName: m.display_name ?? m.displayName ?? m.name ?? m.id,
    label: m.magpie_label ?? m.display_name ?? m.displayName ?? m.id,
    vendor: m.owned_by ?? m.vendor ?? m.provider,
    contextTokenLimit: m.context_length ?? m.context_window ?? m.contextTokenLimit,
  })).filter(m => m.apiModel)
}
async function syncModels(providerId, filter) {
  const cfg = loadConfig()
  const providers = (cfg.providers ?? []).filter(p => !providerId || p.id === providerId)
  if (!providers.length) return 'no matching provider'
  let added = 0, total = 0
  const notes = []
  for (const p of providers) {
    let upstream
    try { upstream = await fetchUpstreamModels(p) } catch (e) { notes.push(`${p.id}: ${e.message}`); continue }
    p.models = p.models ?? []
    const ids = new Set(p.models.map(m => m.id))
    for (const u of upstream) {
      total++
      if (filter && !u.apiModel.toLowerCase().includes(filter.toLowerCase()) && !String(u.label).toLowerCase().includes(filter.toLowerCase())) continue
      const had = p.models.find(m => m.apiModel === u.apiModel)
      if (had) { had.displayName = u.label; if (u.contextTokenLimit) had.contextTokenLimit = u.contextTokenLimit; continue }
      let id = sanitizeId(u.apiModel)
      if (ids.has(id)) id = `${p.id}-${id}`
      while (ids.has(id)) id = `${id}-x`
      ids.add(id)
      p.models.push({ id, apiModel: u.apiModel, displayName: u.label, supportsAgent: true, thinking: false, ...(u.contextTokenLimit ? { contextTokenLimit: u.contextTokenLimit } : {}) })
      added++
    }
  }
  if (!(cfg.providers ?? []).some(p => (p.models ?? []).some(m => m.defaultOn)) && cfg.providers?.[0]?.models?.length)
    cfg.providers[0].models[0].defaultOn = true
  saveConfig(cfg)
  return `added ${added} model(s) (upstream ${total})${notes.length ? ` — ${notes.join('; ')}` : ''}`
}

// ── daemon ──
function readPid() { try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || null } catch { return null } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
// fall back to whatever is listening on the port (stale pid file, manually started, ...)
function pidOnPort(port) {
  try {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' })
    for (const line of (r.stdout ?? '').split('\n')) {
      const m = /TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line)
      if (m && Number(m[1]) === Number(port)) return Number(m[2])
    }
  }
  catch { /* ignore */ }
  return null
}
function killPid(pid) {
  try { process.kill(pid) } catch { try { spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }) } catch { /* ignore */ } }
}
function probeHealth(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 800 }, (res) => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => resolve(true))
    })
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}
async function startServer() {
  if (!fs.existsSync(SERVER)) return 'not built yet — run: npm run build'
  const cfg = loadConfig()
  const host = cfg.host ?? '127.0.0.1'
  const port = cfg.port ?? 39831
  const url = endpointUrl(cfg)
  const http1 = ensureHttp1ForAgent() ? ' (set useHttp1ForAgent)' : ''
  // adopt an instance that is already serving (stale pid file, second terminal, ...)
  if (await probeHealth(host, port)) {
    const existing = readPid() ?? pidOnPort(port)
    if (existing) fs.writeFileSync(PID_FILE, String(existing))
    setUserEnv('CURSOR_API_ENDPOINT', url)
    state.defaultEndpoint = url
    return `already running on ${host}:${port} (pid ${existing ?? '?'}) — endpoint set${http1}`
  }
  const fd = fs.openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ['ignore', fd, fd], cwd: STATE_DIR, env: { ...process.env, BYOK_HOST: host, BYOK_PORT: String(port) } })
  child.unref()
  fs.closeSync(fd)
  // don't claim success until it is actually listening (EADDRINUSE used to slip through)
  for (let i = 0; i < 12; i++) {
    await sleep(250)
    if (!pidAlive(child.pid)) { try { fs.unlinkSync(PID_FILE) } catch {}; return 'failed to start — see logs/server-daemon.log' }
    if (await probeHealth(host, port)) {
      fs.writeFileSync(PID_FILE, String(child.pid))
      setUserEnv('CURSOR_API_ENDPOINT', url)
      state.defaultEndpoint = url
      return `started pid ${child.pid} — endpoint ${url} set${http1} (open a new terminal)`
    }
  }
  return 'started, but /health did not answer yet — check logs/server-daemon.log'
}
function stopServer() {
  const port = loadConfig().port ?? 39831
  const pid = readPid() ?? pidOnPort(port)
  // leaving it set while the service is down would break plain cursor-agent
  setUserEnv('CURSOR_API_ENDPOINT', null)
  state.defaultEndpoint = ''
  if (!pid) return 'not running'
  killPid(pid)
  try { fs.unlinkSync(PID_FILE) } catch {}
  return `stopped pid ${pid} — endpoint cleared`
}
const restartServer = async () => { stopServer(); await sleep(500); return startServer() }

// ── user-level env: make plain `cursor-agent` / `agent` route to this server ──
function getUserEnv(name) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: 'utf8' })
  return (r.stdout || '').trim()
}
function setUserEnv(name, value) {
  const cmd = value == null
    ? `[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`
    : `[Environment]::SetEnvironmentVariable('${name}', '${value}', 'User')`
  return spawnSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' }).status === 0
}
const endpointUrl = cfg => `http://${cfg.host ?? '127.0.0.1'}:${cfg.port ?? 39831}`

// The agent channel defaults to HTTP/2; the Fastify server speaks HTTP/1.1.
const CLI_CONFIG = path.join(os.homedir(), '.cursor', 'cli-config.json')
function ensureHttp1ForAgent() {
  try {
    let c = {}
    try { c = JSON.parse(fs.readFileSync(CLI_CONFIG, 'utf8')) } catch { /* fresh */ }
    c.network = c.network ?? {}
    if (c.network.useHttp1ForAgent === true) return false
    c.network.useHttp1ForAgent = true
    fs.mkdirSync(path.dirname(CLI_CONFIG), { recursive: true })
    fs.writeFileSync(CLI_CONFIG, JSON.stringify(c, null, 2))
    return true
  }
  catch { return false }
}

// ── terminal ──
function enterTui() { process.stdout.write(`${ESC}?1049h${ESC}?25l`) }
function leaveTui() { process.stdout.write(`${ESC}?25h${ESC}?1049l`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const CANCELLED = Symbol('cancelled')
function ask(question) {
  return new Promise((resolve) => {
    state.prompting = true
    // stay in raw mode: cooked mode buffers Esc until Enter, so it would not cancel
    try { process.stdin.setRawMode(true) } catch {}
    process.stdin.resume()
    process.stdout.write(`${ESC}?25h${ESC}2J${ESC}H` + question + `${c.gray}(Esc cancel)${c.reset} `)
    let buf = ''
    let done = false
    const finish = (val) => {
      if (done) return
      done = true
      process.stdin.removeListener('data', onData)
      state.prompting = false
      process.stdout.write(`${ESC}?25l\n`)
      // keep stdin flowing so the TUI stays responsive (this was the hang)
      process.stdin.resume()
      resolve(val)
    }
    const onData = (d) => {
      const s = d.toString('utf8')
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (ch === '\x1b') {
          if (s[i + 1] === '[') { i += 2; continue } // arrow / function key
          return finish(null) // Esc cancels
        }
        if (ch === '\r' || ch === '\n') return finish(buf.trim())
        if (ch === '\x03') cleanupAndExit()
        if (ch === '\x7f' || ch === '\b') { buf = buf.slice(0, -1); process.stdout.write('\b \b') }
        else { buf += ch; process.stdout.write(ch) }
      }
    }
    process.stdin.on('data', onData)
  })
}
// ask, but abort the whole flow on Esc
async function askReq(q) {
  const v = await ask(q)
  if (v === null) throw CANCELLED
  return v
}

// ── state ──
const state = { view: 'main', server: { running: false, pid: null, health: false }, prompting: false, message: '', providerIndex: 0, logScroll: 0, cfg: loadConfig(), defaultEndpoint: undefined }
const setMessage = m => { state.message = m }

async function refreshStatus() {
  const pid = readPid()
  state.server.pid = pid
  state.server.running = pidAlive(pid)
  state.cfg = loadConfig()
  state.server.health = state.server.running ? await probeHealth(state.cfg.host ?? '127.0.0.1', state.cfg.port ?? 39831) : false
  draw()
}

// ── rendering ──
function statusLine() {
  const s = state.server, cfg = state.cfg
  const dot = s.running ? `${c.green}● running${c.reset}` : `${c.red}○ stopped${c.reset}`
  const models = allModels(cfg).length
  const extra = s.running ? `pid ${s.pid}  http://${cfg.host ?? '127.0.0.1'}:${cfg.port ?? 39831}` : `${c.gray}service down${c.reset}`
  return `  ${dot}  ${extra}  ${c.gray}providers ${(cfg.providers ?? []).length} · models ${models}${c.reset}`
}
// ANSI-aware truncate to the terminal width, counting CJK/full-width chars as 2 columns.
function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a
    || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x20000 && cp <= 0x3fffd)
}
function fit(s, width) {
  let w = 0, out = '', i = 0
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(s.slice(i))
      if (m) { out += m[0]; i += m[0].length; continue }
    }
    const cp = s.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    const cw = isWide(cp) ? 2 : 1
    if (w + cw > width - 1) break
    out += ch; w += cw; i += ch.length
  }
  return `${out}\x1b[0m`
}
function render(lines) {
  const width = process.stdout.columns || 100
  const height = process.stdout.rows || 40
  const shown = lines.slice(0, height)
  let buf = `${ESC}?25l${ESC}H`
  for (let i = 0; i < shown.length; i++) {
    buf += fit(shown[i], width) + `${ESC}K`
    if (i < shown.length - 1) buf += '\n'
  }
  buf += `${ESC}J`
  process.stdout.write(buf)
}

function draw() {
  // always re-read config so the providers list reflects changes immediately
  state.cfg = loadConfig()
  const cfg = state.cfg
  const out = []
  out.push(`${c.bold}${c.cyan}  ccursor-cli${c.reset}  ${c.gray}vendored BYOK server + provider manager${c.reset}`)
  out.push(statusLine())
  out.push(`${c.gray}  ${'─'.repeat(Math.max(10, (process.stdout.columns || 80) - 4))}${c.reset}`)
  if (state.view === 'main') {
    out.push('')
    out.push('   [s] start service        [x] stop service')
    out.push('   [p] providers            [l] logs')
    out.push('   [q] quit (service keeps running)')
    const ep = state.defaultEndpoint
    out.push('')
    out.push(ep
      ? `   ${c.gray}endpoint: ${ep}  — plain ${c.reset}cursor-agent${c.gray}/${c.reset}agent${c.gray} route here${c.reset}`
      : `   ${c.gray}endpoint: off — plain cursor-agent uses Cursor${c.reset}`)
    out.push('')
    if (!(state.cfg.providers ?? []).length)
      out.push(`   ${c.yellow}no provider configured yet — press [p] then [a] to add one (baseUrl + apiKey)${c.reset}`)
    out.push(`${c.gray}   providers: ${CONFIG}${c.reset}`)
    out.push(`${c.gray}   server:    ${SERVER}${c.reset}`)
  }
  else if (state.view === 'providers') {
    const ps = cfg.providers ?? []
    const sel = Math.min(Math.max(0, state.providerIndex), Math.max(0, ps.length - 1))
    out.push('')
    out.push(`   ${c.bold}Providers${c.reset} (${ps.length})`)
    if (!ps.length) out.push(`   ${c.gray}(none — press a to add one)${c.reset}`)
    ps.forEach((p, i) => {
      const line = `${i + 1}) ${p.name || p.id}  ${p.id}  ${p.type ?? 'openai-chat'}  ${p.baseUrl}  [${(p.models ?? []).length} models]`
      out.push(i === sel ? `   ${c.cyan}${c.bold}▸ ${line}${c.reset}` : `   ${c.gray}  ${line}${c.reset}`)
    })
    out.push('')
    out.push('   [a] add    [e] edit    [d] delete    [f] re-fetch    [↑/↓] select    [b] back')
    out.push(`   ${c.gray}models are fetched automatically when you add or edit a provider${c.reset}`)
  }
  else if (state.view === 'logs') {
    out.push('')
    let all = []
    try { all = fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n') } catch { all = ['(no log yet)'] }
    const H = 18
    const maxScroll = Math.max(0, all.length - H)
    const scroll = Math.min(state.logScroll ?? 0, maxScroll)
    const end = all.length - scroll
    const start = Math.max(0, end - H)
    out.push(`   ${c.bold}Logs${c.reset} ${c.gray}lines ${start + 1}-${end} / ${all.length}   (↑ ↓ PgUp PgDn g G scroll)${c.reset}`)
    for (const l of all.slice(start, end)) out.push(`   ${c.gray}${l.slice(0, 120)}${c.reset}`)
    out.push('')
    out.push('   [b] back')
  }
  if (state.message) { out.push(''); out.push(`   ${c.cyan}${state.message}${c.reset}`) }
  render(out)
}

// ── actions ──
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
function uniqueProviderId(name, keepId) {
  if (keepId) return keepId // editing: keep the existing id
  const base = slug(name) || 'provider'
  const taken = new Set((loadConfig().providers ?? []).map(x => x.id))
  let id = base, n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  return id
}
async function editProvider(existing) {
  const p = existing ?? {}
  const name = (await askReq(`Name            [${p.name ?? ''}]: `)) || p.name || ''
  const baseUrl = (await askReq(`Base URL /v1    [${p.baseUrl ?? 'http://127.0.0.1:3425/v1'}]: `)) || p.baseUrl || 'http://127.0.0.1:3425/v1'
  const apiKey = (await askReq(`API key         [${providerKey(p) || 'local'}]: `)) || providerKey(p) || 'local'
  const type = (await askReq(`Type (openai-chat|anthropic|openai-responses|gemini) [${p.type ?? 'openai-chat'}]: `)) || p.type || 'openai-chat'
  // id is derived from the name (kept unchanged when editing)
  return { id: uniqueProviderId(name, p.id), name, type, baseUrl, auth: { kind: 'apiKey', value: apiKey }, models: p.models ?? [] }
}
// ── key handling ──
async function onKey(key) {
  const st = state
  if (st.view === 'main') {
    if (key === 's') { setMessage(await startServer()); await sleep(400) }
    else if (key === 'x') setMessage(stopServer())
    else if (key === 'p') { st.view = 'providers'; st.providerIndex = 0; st.message = '' }
    else if (key === 'l') { st.view = 'logs'; st.logScroll = 0; st.message = '' }
    else if (key === 'q') cleanupAndExit()
  }
  else if (st.view === 'providers') {
    const ps = () => loadConfig().providers ?? []
    const count = ps().length
    const clamp = () => { st.providerIndex = Math.min(Math.max(0, st.providerIndex ?? 0), Math.max(0, count - 1)) }
    if (key === 'b') { st.view = 'main'; st.message = '' }
    else if (key === 'up' || key === 'k') { st.providerIndex = Math.max(0, (st.providerIndex ?? 0) - 1) }
    else if (key === 'down' || key === 'j') { st.providerIndex = Math.min(Math.max(0, count - 1), (st.providerIndex ?? 0) + 1) }
    else if (key === 'a') {
      const v = st.view; st.view = 'main'; draw()
      try {
        const p = await editProvider(null)
        const cfg = loadConfig(); cfg.providers = cfg.providers ?? []; cfg.providers.push(p); saveConfig(cfg)
        st.view = v; st.providerIndex = (cfg.providers.length - 1); setMessage('fetching models...'); draw()
        setMessage(`added ${p.id} — ${await syncModels(p.id)}`)
      }
      catch (e) { st.view = v; setMessage(e === CANCELLED ? 'cancelled' : `error: ${e.message}`) }
    }
    else if (key === 'e') {
      try {
        clamp()
        const cfg = loadConfig()
        const cur = cfg.providers?.[st.providerIndex]
        if (!cur) throw new Error('no provider selected')
        const p = await editProvider(cur)
        cfg.providers[st.providerIndex] = p; saveConfig(cfg)
        setMessage('fetching models...'); draw()
        setMessage(`updated ${p.id} — ${await syncModels(p.id)}`)
      }
      catch (e) { setMessage(e === CANCELLED ? 'cancelled' : `error: ${e.message}`) }
    }
    else if (key === 'd') {
      try {
        clamp()
        const cfg = loadConfig()
        const cur = cfg.providers?.[st.providerIndex]
        if (!cur) throw new Error('no provider selected')
        cfg.providers.splice(st.providerIndex, 1); saveConfig(cfg)
        clamp(); setMessage(`deleted ${cur.id}`)
      }
      catch (e) { setMessage(`error: ${e.message}`) }
    }
    else if (key === 'f') {
      try {
        clamp()
        const cur = loadConfig().providers?.[st.providerIndex]
        if (!cur) throw new Error('no provider selected')
        setMessage('fetching...'); draw()
        setMessage(`${cur.id}: ${await syncModels(cur.id)} — restart service to apply`)
      }
      catch (e) { setMessage(`error: ${e.message}`) }
    }
  }
  else if (st.view === 'logs') {
    if (key === 'b') { st.view = 'main'; st.message = '' }
    else if (key === 'up' || key === 'k') st.logScroll = (st.logScroll ?? 0) + 1
    else if (key === 'down' || key === 'j') st.logScroll = Math.max(0, (st.logScroll ?? 0) - 1)
    else if (key === 'pgup') st.logScroll = (st.logScroll ?? 0) + 10
    else if (key === 'pgdn') st.logScroll = Math.max(0, (st.logScroll ?? 0) - 10)
    else if (key === 'G' || key === 'end') st.logScroll = 1e9
    else if (key === 'g' || key === 'home') st.logScroll = 0
  }
  draw()
}

// ── lifecycle ──
let cleaned = false
function cleanupAndExit() {
  if (cleaned) return
  cleaned = true
  try { process.stdin.setRawMode(false) } catch {}
  leaveTui()
  process.stdout.write('\n  ccursor-cli closed. The BYOK service keeps running.\n')
  process.exit(0)
}

// ── non-interactive CLI mode ──
const argv = process.argv.slice(2)
if (argv.length) {
  const [cmd, ...rest] = argv
  if (cmd === '--start') console.log(await startServer())
  else if (cmd === '--stop') console.log(stopServer())
  else if (cmd === '--restart') console.log(await restartServer())
  else if (cmd === '--status') {
    const cfg = loadConfig(); const pid = readPid(); const running = pidAlive(pid)
    console.log(`service  : ${running ? `running (pid ${pid})` : 'stopped'}`)
    console.log(`endpoint : http://${cfg.host ?? '127.0.0.1'}:${cfg.port ?? 39831}`)
    console.log(`server   : ${SERVER}`)
    console.log(`providers: ${(cfg.providers ?? []).length}, models: ${allModels(cfg).length}`)
    ;(cfg.providers ?? []).forEach(p => console.log(`  - ${p.id}  ${p.baseUrl}  [${(p.models ?? []).length} models]`))
  }
  else if (cmd === '--providers') {
    const cfg = loadConfig()
    ;(cfg.providers ?? []).forEach(p => { console.log(`${p.id}  ${p.name}  ${p.type ?? 'openai-chat'}  ${p.baseUrl}`); (p.models ?? []).forEach(m => console.log(`   - ${m.id} -> ${m.apiModel}${m.defaultOn ? '  (default)' : ''}`)) })
  }
  else if (cmd === '--sync') {
    console.log(await syncModels(rest[0], rest[1]))
    console.log('restart the daemon to apply:  node src/cli.mjs --restart')
  }
  else if (cmd === '--default-endpoint') {
    const cfg = loadConfig()
    if (rest[0] === 'off') { setUserEnv('CURSOR_API_ENDPOINT', null); console.log('CURSOR_API_ENDPOINT cleared') }
    else { const url = endpointUrl(cfg); setUserEnv('CURSOR_API_ENDPOINT', url); console.log(`CURSOR_API_ENDPOINT = ${url}`) }
    console.log('open a new terminal for it to take effect')
  }
  else if (cmd === '--render') { state.server.pid = readPid(); state.server.running = pidAlive(state.server.pid); state.defaultEndpoint = getUserEnv('CURSOR_API_ENDPOINT'); state.view = rest[0] ?? 'main'; draw() }
  else { console.log('usage: ccursor-cli [--start|--stop|--restart|--status|--providers|--sync [id] [filter]|--default-endpoint on|off|--render [view]]'); process.exitCode = 2 }
  process.exit(0)
}

process.on('SIGINT', cleanupAndExit)
process.on('SIGTERM', cleanupAndExit)
if (!process.stdin.isTTY) { console.log('ccursor-cli: not an interactive terminal. Use --start/--status/--providers/--sync.'); process.exit(0) }

enterTui()
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.on('resize', () => draw())
state.defaultEndpoint = getUserEnv('CURSOR_API_ENDPOINT')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  if (state.prompting) return
  const s = d.toString('utf8')
  const keys = []
  let i = 0
  while (i < s.length) {
    if (s[i] === '\x1b' && s[i + 1] === '[') {
      const code = s[i + 2]
      if (code === 'A') { keys.push('up'); i += 3 }
      else if (code === 'B') { keys.push('down'); i += 3 }
      else if (code === 'C') { keys.push('right'); i += 3 }
      else if (code === 'D') { keys.push('left'); i += 3 }
      else if (code === 'H') { keys.push('home'); i += 3 }
      else if (code === 'F') { keys.push('end'); i += 3 }
      else if (code === '5' && s[i + 3] === '~') { keys.push('pgup'); i += 4 }
      else if (code === '6' && s[i + 3] === '~') { keys.push('pgdn'); i += 4 }
      else i += 3
    }
    else { keys.push(s[i]); i++ }
  }
  for (const k of keys) onKey(k)
})
draw()
refreshStatus()
// refresh status + config on every view (never while a prompt is open)
setInterval(() => { if (!state.prompting) refreshStatus() }, 3000)
