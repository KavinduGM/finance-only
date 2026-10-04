// Emergency password reset, for when nobody can sign in.
//
//   npm run reset-password --prefix backend -- <username>
//   (inside the container:  node backend/src/scripts/reset-password.js <username>)
//
// Prints a temporary password that must be changed at the next login.

const db = require('../database');
const auth = require('../services/authService');

async function main() {
  const username = process.argv[2];
  if (!username) {
    const users = db.prepare('SELECT username, role, is_active FROM users ORDER BY username').all();
    console.log('Usage: reset-password <username>\n\nAccounts:');
    for (const u of users) console.log(`  ${u.username}  (${u.role}${u.is_active ? '' : ', inactive'})`);
    process.exit(1);
  }

  const user = db.prepare('SELECT id, username FROM users WHERE username=?').get(username);
  if (!user) {
    console.error(`No account named "${username}"`);
    process.exit(1);
  }

  const password = auth.generatePassword(16);
  await auth.setPassword(user.id, password, { mustChange: true });
  db.prepare('UPDATE users SET is_active=1 WHERE id=?').run(user.id);
  auth.destroyUserSessions(user.id);
  auth.audit(null, 'password_reset_cli', `username=${user.username}`);

  console.log(`\nTemporary password for "${user.username}": ${password}`);
  console.log('It must be changed at the next sign-in.\n');
  db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
