'use strict';

const elements = Object.fromEntries([
  'login-view', 'app-view', 'logout-button', 'login-form', 'password', 'login-error',
  'new-client-button', 'create-panel', 'cancel-create-button', 'create-form', 'client-name', 'client-protocol',
  'create-error', 'page-message', 'endpoint-value', 'client-count', 'connected-count', 'amneziawg-version',
  'client-rows', 'empty-state', 'empty-create-button', 'refresh-button', 'last-updated',
  'qr-dialog', 'qr-title', 'qr-image', 'close-qr-button',
  'peer-connection-dialog', 'peer-connection-title', 'close-peer-connection', 'peer-connection-form',
  'peer-connection-enabled', 'peer-connection-fields', 'peer-connection-endpoint', 'peer-connection-keepalive', 'peer-connection-error',
  'upstream-listen-port', 'upstream-port-hint', 'upstream-port-dialog', 'upstream-port-title',
  'close-upstream-port', 'upstream-port-form', 'upstream-port-value', 'upstream-port-range', 'upstream-port-error',
  'primary-nav', 'clients-page', 'routing-page', 'new-upstream-button', 'new-policy-button',
  'dns-status', 'dns-upstream', 'upstream-count', 'policy-count',
  'default-route-form', 'default-route', 'default-route-error',
  'upstream-create-panel', 'cancel-upstream-button', 'upstream-form', 'upstream-name',
  'upstream-file', 'upstream-config', 'upstream-error', 'upstream-rows', 'upstream-empty',
  'policy-create-panel', 'cancel-policy-button', 'policy-form', 'policy-name',
  'policy-priority', 'policy-route', 'policy-domains', 'policy-networks', 'policy-error',
  'policy-rows', 'policy-empty', 'policy-create-title', 'policy-submit-button',
].map((id) => [id, document.getElementById(id)]));

let refreshTimer;
let editingPolicyId = null;
let editingPeerId = null;
let editingUpstreamId = null;
let publishedUpstreamPorts = [];

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  });
  if (response.status === 401 && url !== '/api/session') showLogin();
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { message = (await response.json()).error || message; } catch (_) { /* Response is not JSON. */ }
    throw new Error(message);
  }
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response.text();
}

function showLogin() {
  clearInterval(refreshTimer);
  elements['app-view'].hidden = true;
  elements['logout-button'].hidden = true;
  elements['primary-nav'].hidden = true;
  elements['login-view'].hidden = false;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  elements.password.focus();
}

function showApp() {
  elements['login-view'].hidden = true;
  elements['app-view'].hidden = false;
  elements['logout-button'].hidden = false;
  elements['primary-nav'].hidden = false;
  refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 5000);
}

function showMessage(message) {
  elements['page-message'].textContent = message;
  elements['page-message'].hidden = !message;
}

function bytes(value) {
  const number = Number(value || 0);
  if (number < 1024) return `${number} B`;
  if (number < 1024 ** 2) return `${(number / 1024).toFixed(1)} KiB`;
  if (number < 1024 ** 3) return `${(number / 1024 ** 2).toFixed(1)} MiB`;
  return `${(number / 1024 ** 3).toFixed(1)} GiB`;
}

function time(value) {
  if (!value) return 'Never';
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(value).toLocaleString();
}

function button(label, style, action) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = `button ${style} compact`;
  item.textContent = label;
  item.addEventListener('click', action);
  return item;
}

function cell(label, content, className = '') {
  const item = document.createElement('td');
  item.dataset.label = label;
  item.className = className;
  if (content instanceof Node) item.append(content); else item.textContent = content;
  return item;
}

function statusBadge(client) {
  const badge = document.createElement('span');
  badge.className = `status-badge ${client.enabled ? 'running' : 'disabled'}`;
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  badge.append(dot, client.enabled ? 'Enabled' : 'Disabled');
  return badge;
}

function stateBadge(label, style) {
  const badge = document.createElement('span');
  badge.className = `status-badge ${style}`;
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  badge.append(dot, label);
  return badge;
}

function routeValue(route) {
  return route.type === 'upstream' ? `upstream:${route.upstreamId}` : route.type;
}

function routeFromValue(value) {
  return value.startsWith('upstream:') ? { type: 'upstream', upstreamId: value.slice(9) } : { type: value };
}

function routeLabel(route, upstreams) {
  if (route.type === 'direct') return 'Direct';
  if (route.type === 'blocked') return 'Blocked';
  return upstreams.find((item) => item.id === route.upstreamId)?.name || 'Missing upstream';
}

function updateRouteSelect(select, upstreams, selected) {
  const previous = selected || select.value;
  select.replaceChildren();
  for (const [value, label] of [['direct', 'Direct via eth0'], ['blocked', 'Blocked']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
  }
  for (const upstream of upstreams) {
    const option = document.createElement('option');
    option.value = `upstream:${upstream.id}`;
    option.textContent = `Upstream: ${upstream.name}${upstream.status === 'up' ? '' : ` (${upstream.status})`}`;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function upstreamConnectionBadge(upstream) {
  const states = {
    connected: ['Connected', 'running', 'A recent authenticated handshake succeeded. Traffic forwarding is not actively probed.'],
    awaiting: ['Awaiting', 'disabled', 'No handshake yet. An idle tunnel may wait for traffic.'],
    idle: ['Idle', 'disabled', 'The previous handshake is old; keepalive is off, so inactivity does not establish a failure.'],
    stale: ['Stale', 'warning', 'No recent handshake despite enabled keepalives. Check reachability and the peer configuration.'],
    unknown: ['Unknown', 'warning', 'The running interface did not provide readable peer status.'],
    disabled: ['Disabled', 'disabled', 'This upstream is disabled.'],
    unavailable: ['Unavailable', 'failed', 'The upstream interface is not running.'],
  };
  const [label, style, description] = states[upstream.connectionStatus] || states.unknown;
  const badge = stateBadge(label, style);
  badge.title = description;
  return badge;
}

function publishedPortsHint() {
  return publishedUpstreamPorts.length ? `Configured published UDP ports: ${publishedUpstreamPorts.join(', ')}. Apply Compose changes before using a new range.` : 'Published port range is unavailable.';
}

function openUpstreamPort(upstream) {
  editingUpstreamId = upstream.id;
  elements['upstream-port-title'].textContent = `Listen port: ${upstream.name}`;
  elements['upstream-port-value'].value = upstream.configuredListenPort || '';
  elements['upstream-port-range'].textContent = publishedPortsHint();
  elements['upstream-port-error'].textContent = '';
  elements['upstream-port-dialog'].showModal();
}

function renderUpstreams(upstreams) {
  elements['upstream-rows'].replaceChildren();
  elements['upstream-empty'].hidden = upstreams.length !== 0;
  for (const upstream of upstreams) {
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(button('Port', 'secondary', () => openUpstreamPort(upstream)));
    actions.append(button(upstream.enabled ? 'Disable' : 'Enable', 'secondary', async () => {
      try {
        await request(`/api/routing/upstreams/${upstream.id}/${upstream.enabled ? 'disable' : 'enable'}`, { method: 'POST' });
        await refresh();
      } catch (error) { showMessage(error.message); }
    }));
    actions.append(button('Delete', 'danger', async () => {
      if (!window.confirm(`Delete upstream “${upstream.name}”? Its imported private config will be removed.`)) return;
      try { await request(`/api/routing/upstreams/${upstream.id}`, { method: 'DELETE' }); await refresh(); }
      catch (error) { showMessage(error.message); }
    }));
    const statusStyle = upstream.status === 'up' ? 'running' : upstream.status === 'disabled' ? 'disabled' : 'failed';
    const transfer = document.createElement('span');
    transfer.className = 'secondary-value numeric';
    transfer.textContent = `↓ ${bytes(upstream.transferRx)}  ↑ ${bytes(upstream.transferTx)}`;
    const interfaceInfo = document.createElement('div');
    interfaceInfo.className = 'resource-details';
    const interfaceName = document.createElement('span');
    interfaceName.className = 'mono';
    interfaceName.textContent = `${upstream.protocol || 'AWG'} · ${upstream.interface} / table ${upstream.table}`;
    interfaceInfo.append(interfaceName, stateBadge(upstream.status === 'up' ? 'Running' : upstream.status, statusStyle));
    const endpointInfo = document.createElement('div');
    endpointInfo.className = 'resource-details';
    const endpointValue = document.createElement('span');
    endpointValue.className = 'mono';
    endpointValue.textContent = upstream.endpoint || '—';
    const portValue = document.createElement('span');
    portValue.className = 'secondary-value';
    portValue.textContent = `Local UDP ${upstream.listenPort || '—'}${upstream.configuredListenPort ? ' · fixed' : ' · automatic'}`;
    if (upstream.configuredListenPort && !upstream.portInPublishedRange) portValue.textContent += ' · outside published range';
    endpointInfo.append(endpointValue, portValue);
    const row = document.createElement('tr');
    row.append(
      cell('Name', upstream.name, 'client-name'),
      cell('Interface', interfaceInfo),
      cell('Endpoint', endpointInfo),
      cell('Connection', upstreamConnectionBadge(upstream)),
      cell('Handshake', time(upstream.latestHandshakeAt), 'numeric'),
      cell('Transfer', transfer),
      cell('Actions', actions, 'actions-column'),
    );
    if (upstream.error) row.title = upstream.error;
    elements['upstream-rows'].append(row);
  }
}

function renderPolicies(policies, upstreams) {
  elements['policy-rows'].replaceChildren();
  elements['policy-empty'].hidden = policies.length !== 0;
  for (const policy of policies) {
    const matches = document.createElement('span');
    matches.className = 'secondary-value';
    matches.textContent = `${policy.domains.length} domain${policy.domains.length === 1 ? '' : 's'}, ${policy.networks.length} network${policy.networks.length === 1 ? '' : 's'}`;
    matches.title = [...policy.domains, ...policy.networks].join('\n');
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(button('Edit', 'secondary', () => openPolicyEditor(policy, upstreams)));
    actions.append(button(policy.enabled ? 'Disable' : 'Enable', 'secondary', async () => {
      try { await request(`/api/routing/policies/${policy.id}/${policy.enabled ? 'disable' : 'enable'}`, { method: 'POST' }); await refresh(); }
      catch (error) { showMessage(error.message); }
    }));
    actions.append(button('Delete', 'danger', async () => {
      if (!window.confirm(`Delete routing policy “${policy.name}”?`)) return;
      try { await request(`/api/routing/policies/${policy.id}`, { method: 'DELETE' }); await refresh(); }
      catch (error) { showMessage(error.message); }
    }));
    const row = document.createElement('tr');
    row.append(
      cell('Priority', String(policy.priority), 'numeric'),
      cell('Name', policy.name, 'client-name'),
      cell('Matches', matches),
      cell('Destination', routeLabel(policy.route, upstreams)),
      cell('Status', stateBadge(policy.enabled ? 'Enabled' : 'Disabled', policy.enabled ? 'running' : 'disabled')),
      cell('Actions', actions, 'actions-column'),
    );
    elements['policy-rows'].append(row);
  }
}

function renderRouting(routing) {
  publishedUpstreamPorts = routing.publishedUpstreamPorts || [];
  elements['upstream-port-hint'].textContent = `${publishedPortsHint()} Leave blank to preserve the imported setting.`;
  elements['dns-upstream'].textContent = routing.dns.upstream;
  elements['upstream-count'].textContent = routing.upstreams.length;
  elements['policy-count'].textContent = routing.policies.length;
  updateRouteSelect(elements['default-route'], routing.upstreams, routeValue(routing.defaultRoute));
  updateRouteSelect(elements['policy-route'], routing.upstreams);
  renderUpstreams(routing.upstreams);
  renderPolicies(routing.policies, routing.upstreams);
}

function updatePeerConnectionFields() {
  const enabled = elements['peer-connection-enabled'].checked;
  elements['peer-connection-fields'].hidden = !enabled;
  for (const id of ['peer-connection-endpoint', 'peer-connection-keepalive']) {
    elements[id].disabled = !enabled;
    elements[id].required = enabled;
  }
}

function openPeerConnection(client) {
  editingPeerId = client.id;
  elements['peer-connection-title'].textContent = `Connection: ${client.name}`;
  elements['peer-connection-enabled'].checked = Boolean(client.reverseInitiation);
  elements['peer-connection-endpoint'].value = client.reverseInitiation?.endpoint || '';
  elements['peer-connection-keepalive'].value = client.reverseInitiation?.persistentKeepalive || 25;
  elements['peer-connection-error'].textContent = '';
  updatePeerConnectionFields();
  elements['peer-connection-dialog'].showModal();
}

function renderClients(clients) {
  elements['client-rows'].replaceChildren();
  elements['empty-state'].hidden = clients.length !== 0;
  for (const client of clients) {
    const row = document.createElement('tr');
    const name = document.createElement('span');
    name.className = 'client-name';
    name.textContent = client.name;
    if (client.reverseInitiation) name.title = `Initiates to ${client.reverseInitiation.endpoint}; keepalive ${client.reverseInitiation.persistentKeepalive}s`;
    const transfer = document.createElement('span');
    transfer.className = 'secondary-value numeric';
    transfer.textContent = `↓ ${bytes(client.transferRx)}  ↑ ${bytes(client.transferTx)}`;
    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const download = document.createElement('a');
    download.className = 'button secondary compact';
    download.textContent = 'Download';
    download.href = `/api/wireguard/client/${client.id}/configuration`;
    actions.append(button('Connection', 'secondary', () => openPeerConnection(client)));
    actions.append(download);
    actions.append(button('QR', 'secondary', () => {
      elements['qr-title'].textContent = `QR code: ${client.name}`;
      elements['qr-image'].src = `/api/wireguard/client/${client.id}/qrcode.svg`;
      elements['qr-dialog'].showModal();
    }));
    actions.append(button(client.enabled ? 'Disable' : 'Enable', 'secondary', async () => {
      try {
        await request(`/api/wireguard/client/${client.id}/${client.enabled ? 'disable' : 'enable'}`, { method: 'POST' });
        await refresh();
      } catch (error) { showMessage(error.message); }
    }));
    actions.append(button('Delete', 'danger', async () => {
      if (!window.confirm(`Delete client “${client.name}”? This permanently removes its private key.`)) return;
      try {
        await request(`/api/wireguard/client/${client.id}`, { method: 'DELETE' });
        await refresh();
      } catch (error) { showMessage(error.message); }
    }));

    row.append(
      cell('Name', name),
      cell('Protocol', client.protocol || 'AWG3', 'mono'),
      cell('Address', client.address, 'mono'),
      cell('Status', statusBadge(client)),
      cell('Latest handshake', time(client.latestHandshakeAt), 'numeric'),
      cell('Transfer', transfer),
      cell('Actions', actions, 'actions-column'),
    );
    elements['client-rows'].append(row);
  }
}

async function refresh() {
  try {
    const [status, clients, routing] = await Promise.all([
      request('/api/wireguard/status'),
      request('/api/wireguard/client'),
      request('/api/routing'),
    ]);
    elements['endpoint-value'].textContent = status.endpoint;
    elements['endpoint-value'].title = status.endpoint;
    elements['amneziawg-version'].textContent = status.amneziawg?.version || 'Unknown';
    elements['amneziawg-version'].title = status.amneziawg?.image || '';
    elements['client-count'].textContent = status.clients;
    elements['connected-count'].textContent = status.connected;
    elements['last-updated'].textContent = `Updated ${new Date().toLocaleTimeString()}`;
    renderClients(clients);
    renderRouting(routing);
    showMessage('');
  } catch (error) {
    if (!elements['app-view'].hidden) showMessage(error.message);
  }
}

function openCreate() {
  elements['create-panel'].hidden = false;
  elements['client-name'].focus();
}

function showPage(page) {
  elements['clients-page'].hidden = page !== 'clients';
  elements['routing-page'].hidden = page !== 'routing';
  for (const item of document.querySelectorAll('.nav-button')) item.classList.toggle('active', item.dataset.page === page);
}

function listValues(value) {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function resetPolicyEditor() {
  editingPolicyId = null;
  elements['policy-form'].reset();
  elements['policy-priority'].value = '100';
  elements['policy-create-title'].textContent = 'New destination policy';
  elements['policy-submit-button'].textContent = 'Create policy';
  elements['policy-error'].textContent = '';
}

function openPolicyEditor(policy = null, upstreams = []) {
  resetPolicyEditor();
  if (policy) {
    editingPolicyId = policy.id;
    elements['policy-create-title'].textContent = 'Edit destination policy';
    elements['policy-submit-button'].textContent = 'Save policy';
    elements['policy-name'].value = policy.name;
    elements['policy-priority'].value = String(policy.priority);
    elements['policy-domains'].value = policy.domains.join('\n');
    elements['policy-networks'].value = policy.networks.join('\n');
    updateRouteSelect(elements['policy-route'], upstreams, routeValue(policy.route));
  }
  elements['policy-create-panel'].hidden = false;
  elements['policy-name'].focus();
}

elements['login-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['login-error'].textContent = '';
  try {
    await request('/api/session', { method: 'POST', body: JSON.stringify({ password: elements.password.value }) });
    elements.password.value = '';
    showApp();
  } catch (error) { elements['login-error'].textContent = error.message; }
});

elements['logout-button'].addEventListener('click', async () => {
  try { await request('/api/session', { method: 'DELETE' }); } finally { showLogin(); }
});
for (const item of document.querySelectorAll('.nav-button')) item.addEventListener('click', () => showPage(item.dataset.page));
elements['new-client-button'].addEventListener('click', openCreate);
elements['empty-create-button'].addEventListener('click', openCreate);
elements['cancel-create-button'].addEventListener('click', () => { elements['create-panel'].hidden = true; elements['create-error'].textContent = ''; });
elements['refresh-button'].addEventListener('click', refresh);
elements['close-qr-button'].addEventListener('click', () => elements['qr-dialog'].close());
elements['qr-dialog'].addEventListener('close', () => { elements['qr-image'].removeAttribute('src'); });
elements['create-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['create-error'].textContent = '';
  try {
    await request('/api/wireguard/client', { method: 'POST', body: JSON.stringify({ name: elements['client-name'].value, protocol: elements['client-protocol'].value }) });
    elements['client-name'].value = '';
    elements['create-panel'].hidden = true;
    await refresh();
  } catch (error) { elements['create-error'].textContent = error.message; }
});

elements['new-upstream-button'].addEventListener('click', () => {
  elements['upstream-create-panel'].hidden = false;
  elements['upstream-name'].focus();
});
elements['cancel-upstream-button'].addEventListener('click', () => {
  elements['upstream-create-panel'].hidden = true;
  elements['upstream-error'].textContent = '';
});
elements['upstream-file'].addEventListener('change', async () => {
  const file = elements['upstream-file'].files[0];
  if (file) elements['upstream-config'].value = await file.text();
});
elements['upstream-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['upstream-error'].textContent = '';
  try {
    await request('/api/routing/upstreams', {
      method: 'POST',
      body: JSON.stringify({ name: elements['upstream-name'].value, config: elements['upstream-config'].value,
        ...(elements['upstream-listen-port'].value ? { listenPort: Number(elements['upstream-listen-port'].value) } : {}) }),
    });
    elements['upstream-form'].reset();
    elements['upstream-create-panel'].hidden = true;
    await refresh();
  } catch (error) { elements['upstream-error'].textContent = error.message; }
});

elements['close-peer-connection'].addEventListener('click', () => elements['peer-connection-dialog'].close());
elements['peer-connection-enabled'].addEventListener('change', updatePeerConnectionFields);
elements['peer-connection-dialog'].addEventListener('close', () => { editingPeerId = null; });
elements['peer-connection-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['peer-connection-error'].textContent = '';
  try {
    const reverseInitiation = elements['peer-connection-enabled'].checked ? {
      endpoint: elements['peer-connection-endpoint'].value.trim(),
      persistentKeepalive: Number(elements['peer-connection-keepalive'].value),
    } : null;
    await request(`/api/wireguard/client/${editingPeerId}/connection`, { method: 'PUT', body: JSON.stringify({ reverseInitiation }) });
    elements['peer-connection-dialog'].close();
    await refresh();
  } catch (error) { elements['peer-connection-error'].textContent = error.message; }
});

elements['close-upstream-port'].addEventListener('click', () => elements['upstream-port-dialog'].close());
elements['upstream-port-dialog'].addEventListener('close', () => { editingUpstreamId = null; });
elements['upstream-port-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['upstream-port-error'].textContent = '';
  try {
    await request(`/api/routing/upstreams/${editingUpstreamId}`, { method: 'PUT', body: JSON.stringify({ listenPort: Number(elements['upstream-port-value'].value || 0) }) });
    elements['upstream-port-dialog'].close();
    await refresh();
  } catch (error) { elements['upstream-port-error'].textContent = error.message; }
});

elements['new-policy-button'].addEventListener('click', () => openPolicyEditor());
elements['cancel-policy-button'].addEventListener('click', () => {
  elements['policy-create-panel'].hidden = true;
  resetPolicyEditor();
});
elements['policy-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['policy-error'].textContent = '';
  try {
    await request(editingPolicyId ? `/api/routing/policies/${editingPolicyId}` : '/api/routing/policies', {
      method: editingPolicyId ? 'PUT' : 'POST',
      body: JSON.stringify({
        name: elements['policy-name'].value,
        priority: Number(elements['policy-priority'].value),
        route: routeFromValue(elements['policy-route'].value),
        domains: listValues(elements['policy-domains'].value),
        networks: listValues(elements['policy-networks'].value),
      }),
    });
    elements['policy-create-panel'].hidden = true;
    resetPolicyEditor();
    await refresh();
  } catch (error) { elements['policy-error'].textContent = error.message; }
});

elements['default-route-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['default-route-error'].textContent = '';
  try {
    await request('/api/routing/default', {
      method: 'PUT',
      body: JSON.stringify({ route: routeFromValue(elements['default-route'].value) }),
    });
    await refresh();
  } catch (error) { elements['default-route-error'].textContent = error.message; }
});

request('/api/session')
  .then((session) => session.authenticated ? showApp() : showLogin())
  .catch(() => showLogin());
