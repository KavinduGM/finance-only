// npm test: runs the end-to-end and restore tests against a throwaway copy of
// the server. Nothing touches backend/data or your backend/.env settings.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const backend = path.join(root, 'backend');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-test-'));
const PORT = process.env.TEST_PORT || '3998';
const ADMIN_PW = 'E2eTestPassw0rd-77'; // test-only, for the throwaway database

// Values set here win over backend/.env (dotenv never overrides), so a real
// Resend key or mailbox on this machine is never used by the tests.
const testEnv = {
  ...process.env,
  NODE_ENV: 'production',
  DATA_DIR: path.join(tmp, 'data'),
  PORT,
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: ADMIN_PW,
  RESTART_ON_RESTORE: 'false',
  TRUST_PROXY: '1',
  RESEND_API_KEY: '',
  EMAIL_FROM: '',
  EMAIL_DISABLED: '',
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args, env) => spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' }).status;

async function main() {
  if (!fs.existsSync(path.join(root, 'frontend', 'dist', 'index.html'))) {
    console.log('Building the frontend first (the tests also check that the server serves the app)...');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (spawnSync(npm, ['run', 'build', '--prefix', 'frontend'], { cwd: root, stdio: 'inherit' }).status !== 0) return 1;
  }

  const server = spawn(process.execPath, ['src/server.js'], { cwd: backend, env: testEnv, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`http://localhost:${PORT}/api/health`)).ok; } catch { /* starting */ }
      if (!up) await sleep(200);
    }
    if (!up) {
      console.error(`The test server did not start on port ${PORT} (is something else using it? set TEST_PORT).`);
      return 1;
    }
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out, { recursive: true });
    const e2e = run([path.join(root, 'tests', 'e2e.mjs')], { ...testEnv, BASE: `http://localhost:${PORT}`, ADMIN_PW, OUT: out });
    server.kill('SIGTERM');
    const restore = run([path.join(root, 'tests', 'restore.mjs')], { ...testEnv, BACKEND: backend, DATA: path.join(tmp, 'restore') });
    return e2e || restore;
  } finally {
    server.kill('SIGTERM');
  }
}

main()
  .then((code) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
