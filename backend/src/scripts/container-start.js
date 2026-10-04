// Container entry point (see Dockerfile).
//
// A freshly mounted volume or host folder can be owned by root. This starts as
// root only long enough to hand the data directory to the unprivileged "node"
// user, then drops privileges before any application code is loaded.

const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || '/data';
const NODE_UID = 1000; // the "node" user in the official Node images
const NODE_GID = 1000;

// Checks every entry, not just the top folder: a database file copied into the
// volume by root would otherwise stay unreadable for the application user.
function fixOwnership(target) {
  const stat = fs.lstatSync(target);
  if (stat.uid !== NODE_UID || stat.gid !== NODE_GID) fs.lchownSync(target, NODE_UID, NODE_GID);
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(target)) fixOwnership(path.join(target, entry));
}

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  fs.mkdirSync(dataDir, { recursive: true });
  fixOwnership(dataDir);
  process.setgroups([NODE_GID]);
  process.setgid(NODE_GID);
  process.setuid(NODE_UID);
}

require('../server');
