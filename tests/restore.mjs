// Restore test: the "before a restore" copy must contain everything, even when
// the server is killed without a clean shutdown, and old sessions must stop working.
// Run it through `npm test`.
//   BACKEND  path to the backend folder
//   DATA     a throwaway data folder (deleted and recreated)
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const BACKEND = process.env.BACKEND
const DATA = process.env.DATA
const PORT = process.env.RESTORE_PORT || '3997'
const BASE = `http://localhost:${PORT}`
const PW = 'RestoreTestPassw0rd-5'
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) pass++; else { fail++; console.log('  FAIL ', name, extra) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function start() {
  return spawn('node', ['src/server.js'], {
    cwd: BACKEND, stdio: 'ignore',
    env: {
      ...process.env, DATA_DIR: DATA, PORT, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: PW,
      NODE_ENV: 'production', RESTART_ON_RESTORE: 'false', RESEND_API_KEY: '', EMAIL_FROM: '',
    },
  })
}
async function up() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return } catch { /* not up yet */ }
    await sleep(150)
  }
  throw new Error('server did not start')
}

let cookie = ''
async function call(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]
  return { status: res.status, data: await res.json().catch(() => null) }
}

console.log('— restore')
fs.rmSync(DATA, { recursive: true, force: true })
let server = start(); await up()
await call('POST', '/api/auth/login', { username: 'admin', password: PW })
await call('POST', '/api/clients', { name: 'Client A (before backup)' })
let r = await call('POST', '/api/backup'); const backupName = r.data.name
await call('POST', '/api/clients', { name: 'Client B (after backup)' })
await call('POST', '/api/clients', { name: 'Client C (after backup)' })
r = await call('POST', `/api/backup/${encodeURIComponent(backupName)}/restore`); ok(r.status === 200, 'restore staged', r.status)

// Worst case: the process dies with no chance to close the database.
server.kill('SIGKILL'); await sleep(400)
server = start(); await up()

r = await call('GET', '/api/clients'); ok(r.status === 401, 'sessions from before the restore are gone', r.status)
cookie = ''
await call('POST', '/api/auth/login', { username: 'admin', password: PW })
r = await call('GET', '/api/clients')
ok(r.status === 200 && r.data.length === 1 && r.data[0].name.startsWith('Client A'), 'live database is the restored backup', JSON.stringify(r.data?.map((c) => c.name)))

const copies = fs.readdirSync(path.join(DATA, 'backups')).filter((f) => f.startsWith('pre-restore-') && f.endsWith('.db'))
ok(copies.length === 1, 'one safety copy was made', copies.join(','))
const out = execFileSync('node', ['-e', `
  const D = require('better-sqlite3'); const d = new D(${JSON.stringify(path.join(DATA, 'backups', copies[0] || 'x'))}, { readonly: true });
  console.log(JSON.stringify(d.prepare('select name from clients order by id').all().map(r => r.name)));
`], { cwd: BACKEND }).toString().trim()
ok(JSON.parse(out).length === 3, 'the safety copy holds everything, including what was only in the write-ahead log', out)

// Restoring that safety copy brings B and C back.
r = await call('POST', `/api/backup/${encodeURIComponent(copies[0])}/restore`); ok(r.status === 200, 'safety copy is accepted for restore', r.status + ' ' + JSON.stringify(r.data))
server.kill('SIGTERM'); await sleep(600)
server = start(); await up()
cookie = ''; await call('POST', '/api/auth/login', { username: 'admin', password: PW })
r = await call('GET', '/api/clients'); ok(r.data.length === 3, 'restoring the safety copy brings everything back', JSON.stringify(r.data?.map((c) => c.name)))

// A maintenance script must not apply a staged restore.
r = await call('POST', `/api/backup/${encodeURIComponent(backupName)}/restore`)
try {
  execFileSync('node', ['src/scripts/reset-password.js'], { cwd: BACKEND, env: { ...process.env, DATA_DIR: DATA }, stdio: 'ignore' })
} catch { /* exits 1 after listing the accounts */ }
ok(fs.existsSync(path.join(DATA, 'financial.db.restore')), 'a maintenance script leaves a staged restore alone')

server.kill('SIGTERM')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
