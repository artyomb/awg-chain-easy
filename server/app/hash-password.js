'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const password = fs.readFileSync(0, 'utf8');
if (password.length < 12) {
  process.stderr.write('Password must contain at least 12 characters.\n');
  process.exit(1);
}
const result = spawnSync('htpasswd', ['-niBC', '12', 'admin'], { input: `${password}\n`, encoding: 'utf8' });
if (result.status !== 0) {
  process.stderr.write(result.stderr || 'Unable to generate password hash.\n');
  process.exit(1);
}
process.stdout.write(`${result.stdout.trim().replace(/^admin:/, '')}\n`);
