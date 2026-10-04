// Runs the API and the web app together for local development:  npm run dev
// API on http://localhost:3001, web app on http://localhost:5173

const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [
  spawn(npm, ['run', 'dev'], { cwd: path.join(root, 'backend'), stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } }),
  spawn(npm, ['run', 'dev'], { cwd: path.join(root, 'frontend'), stdio: 'inherit' }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

for (const child of children) child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
