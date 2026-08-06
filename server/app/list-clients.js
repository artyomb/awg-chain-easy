'use strict';

const fs = require('node:fs');

const state = JSON.parse(fs.readFileSync('/etc/wireguard/wg0.json', 'utf8'));
const clients = Object.values(state.clients || {}).sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }));
if (!clients.length) {
  console.log('No clients configured.');
  process.exit(0);
}
for (const client of clients) {
  console.log(`${client.enabled ? 'enabled ' : 'disabled'}\t${client.address}\t${client.name}\t${client.id}`);
}

