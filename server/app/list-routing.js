'use strict';

const fs = require('node:fs');

const state = JSON.parse(fs.readFileSync('/etc/wireguard/routing.json', 'utf8'));
const route = (value) => value.type === 'upstream'
  ? `upstream:${state.upstreams[value.upstreamId]?.name || value.upstreamId}`
  : value.type;

console.log(`Default: ${route(state.defaultRoute)}`);
console.log('Upstreams:');
for (const upstream of Object.values(state.upstreams).sort((a, b) => a.slot - b.slot)) {
  console.log(`  ${upstream.name}\t${upstream.enabled ? 'enabled' : 'disabled'}\t${upstream.interface}\ttable ${upstream.table}`);
}
console.log('Policies:');
for (const policy of Object.values(state.policies).sort((a, b) => a.priority - b.priority)) {
  const matches = [...policy.domains, ...policy.networks].join(', ');
  console.log(`  ${policy.priority}\t${policy.enabled ? 'enabled' : 'disabled'}\t${policy.name}\t${route(policy.route)}\t${matches}`);
}
