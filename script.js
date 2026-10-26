/* DHCP (DORA) browser simulation. Models DHCP in JavaScript only; no real network traffic. */
(function () {
  'use strict';

  const PCS = ['PC0', 'PC1', 'PC2'];
  const STAGES = [
    null,
    { name: 'DHCPDISCOVER', text: 'Stage 1 – Discover: each client has no IP address, so it broadcasts DHCPDISCOVER (UDP 68 → 255.255.255.255:67) to find a DHCP server.' },
    { name: 'DHCPOFFER', text: 'Stage 2 – Offer: the server picks an unused address from its pool and sends DHCPOFFER with the mask, gateway, DNS and lease time.' },
    { name: 'DHCPREQUEST', text: 'Stage 3 – Request: each client broadcasts DHCPREQUEST to accept the offered address.' },
    { name: 'DHCPACK', text: 'Stage 4 – Acknowledge: the server confirms the lease with DHCPACK and the client starts using the address.' }
  ];
  const AUTO_DELAY_MS = 1500;

  /* ---------- Central state ---------- */
  const state = {
    serverOn: true,
    config: null,            // last applied (validated) configuration
    leases: [null, null, null],
    offers: [null, null, null],
    stage: 0,                // 0 = none, 1-4 = last completed stage
    status: 'idle',          // idle | auto | manual | complete | failed
    timer: null
  };

  const $ = (id) => document.getElementById(id);
  const ids = ['poolName', 'serverIp', 'mask', 'startIp', 'gateway', 'dns', 'lease'];

  /* ---------- IPv4 helpers ---------- */
  function parseIp(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s).trim());
    if (!m) return null;
    let n = 0;
    for (let i = 1; i <= 4; i++) {
      if (m[i].length > 1 && m[i][0] === '0') return null;   // reject leading zeros
      const o = Number(m[i]);
      if (o > 255) return null;
      n = n * 256 + o;
    }
    return n >>> 0;
  }
  function ipStr(n) { return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }
  function prefixOf(mask) {            // returns prefix length or -1 if non-contiguous
    let ones = 0, seenZero = false;
    for (let b = 31; b >= 0; b--) {
      const bit = (mask >>> b) & 1;
      if (bit) { if (seenZero) return -1; ones++; } else seenZero = true;
    }
    return ones;
  }

  /* ---------- Validation & address allocation ---------- */
  function readForm() {
    const v = {};
    ids.forEach((id) => { v[id] = $(id).value.trim(); });
    return v;
  }
  function validate(v) {
    const errors = [], bad = [];
    const fail = (id, msg) => { errors.push(msg); bad.push(id); };
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(v.poolName)) fail('poolName', 'Pool name: use 1–32 letters, digits, "_" or "-".');
    const server = parseIp(v.serverIp), mask = parseIp(v.mask), start = parseIp(v.startIp),
          gw = parseIp(v.gateway), dns = parseIp(v.dns);
    if (server === null) fail('serverIp', 'DHCP server IP is not a valid IPv4 address.');
    if (mask === null) fail('mask', 'Subnet mask is not a valid IPv4 address.');
    else { const p = prefixOf(mask); if (p < 8 || p > 30) fail('mask', 'Subnet mask must be contiguous, between /8 and /30 (e.g. 255.255.255.0).'); }
    if (start === null) fail('startIp', 'Starting client IP is not a valid IPv4 address.');
    if (gw === null) fail('gateway', 'Default gateway is not a valid IPv4 address.');
    if (dns === null) fail('dns', 'DNS server is not a valid IPv4 address.');
    const lease = Number(v.lease);
    if (!/^\d+$/.test(v.lease) || lease < 1 || lease > 720) fail('lease', 'Lease duration must be a whole number from 1 to 720 hours.');
    if (errors.length) return { errors, bad };

    const net = (server & mask) >>> 0, bcast = (net | (~mask >>> 0)) >>> 0;
    const inNet = (ip) => ((ip & mask) >>> 0) === net;
    if (!inNet(server) || server === net || server === bcast) fail('serverIp', 'Server IP must be a usable host address.');
    if (!inNet(start) || start === net || start === bcast) fail('startIp', 'Starting client IP must be a usable address inside the server\'s subnet.');
    if (!inNet(gw) || gw === net || gw === bcast) fail('gateway', 'Default gateway must be a usable address inside the subnet.');
    if (errors.length) return { errors, bad };

    const cfg = { poolName: v.poolName, server, mask, start, gateway: gw, dns, leaseHours: lease, net, bcast };
    const pool = allocate(cfg, PCS.length);
    if (!pool) return { errors: ['Address pool too small: at least 3 free addresses are needed from the starting IP to the end of the subnet (the server and gateway addresses are skipped).'], bad: ['startIp', 'mask'] };
    return { cfg, errors: [], bad: [] };
  }
  /* Allocates `count` unique addresses; skips server, gateway, network and broadcast. */
  function allocate(cfg, count) {
    const out = [];
    for (let a = cfg.start; a < cfg.bcast && out.length < count; a++) {
      if (a === cfg.server || a === cfg.gateway || a === cfg.net) continue;
      out.push(a >>> 0);
    }
    return out.length === count ? out : null;
  }

  /* ---------- Logging ---------- */
  function log(msg, type) {
    const box = $('log'), row = document.createElement('div');
    const t = document.createElement('span'); t.className = 't'; t.textContent = '[' + new Date().toLocaleTimeString() + '] ';
    const m = document.createElement('span'); m.className = type || 'info'; m.textContent = msg;
    row.append(t, m); box.appendChild(row); box.scrollTop = box.scrollHeight;
  }

  /* ---------- Rendering (everything is derived from `state`) ---------- */
  function setBanner(text, kind) { const b = $('banner'); b.textContent = text; b.className = 'banner' + (kind ? ' ' + kind : ''); }
  function render() {
    const running = state.status === 'auto' || state.status === 'manual';
    $('topo').classList.toggle('live', running);
    $('topo').classList.toggle('down', !state.serverOn);
    const badge = $('topo-server-state');
    badge.textContent = state.serverOn ? 'ON' : 'OFF'; badge.className = 'badge ' + (state.serverOn ? 'on' : 'off');
    $('topo-server-ip').textContent = state.config ? ipStr(state.config.server) : $('serverIp').value.trim() || '—';
    $('btn-power').textContent = state.serverOn ? 'Turn Server OFF' : 'Turn Server ON';
    $('btn-run').disabled = running;
    $('btn-next').disabled = state.status === 'auto';
    $('btn-apply').disabled = running;
    ids.forEach((id) => { $(id).disabled = running; });

    document.querySelectorAll('#dora li').forEach((li) => {
      const s = Number(li.dataset.stage);
      li.className = '';
      if (state.status === 'failed' && s === state.stage + 1) li.className = 'failed';
      else if (s <= state.stage) li.className = (s === state.stage && running) ? 'current' : 'done';
    });

    const body = $('ip-body'); body.textContent = '';
    PCS.forEach((pc, i) => {
      const L = state.leases[i], tr = document.createElement('tr');
      const cells = [['Client', pc], ['IPv4 address', L ? ipStr(L.ip) : '—'], ['Subnet mask', L ? ipStr(L.mask) : '—'],
        ['Gateway', L ? ipStr(L.gateway) : '—'], ['DNS', L ? ipStr(L.dns) : '—'], ['Lease', L ? L.hours + ' hours' : '—']];
      cells.forEach(([label, val], k) => { const td = document.createElement('td'); td.dataset.label = label; td.textContent = val; if (k) td.className = 'mono'; tr.appendChild(td); });
      const td = document.createElement('td'); td.dataset.label = 'Status';
      td.className = 'status ' + (L ? 'ok' : 'wait'); td.textContent = L ? 'Configured' : 'Waiting for IP address'; tr.appendChild(td);
      body.appendChild(tr);
      document.querySelector('[data-topo-ip="' + i + '"]').textContent = L ? ipStr(L.ip) : 'Waiting…';
      document.querySelector('.device[data-pc="' + i + '"]').classList.toggle('has-ip', !!L);
    });
  }
  function setExplain(t) { $('explain').textContent = t; }

  /* ---------- Simulation control ---------- */
  function clearTimer() { if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; } }
  function showErrors(list, bad) {
    $('cfg-error').textContent = list.join('\n');
    ids.forEach((id) => $(id).classList.toggle('bad', bad.indexOf(id) !== -1));
  }
  function applyConfig(quiet) {
    const res = validate(readForm());
    showErrors(res.errors, res.bad);
    if (res.errors.length) { log('Configuration rejected: ' + res.errors[0], 'error'); setBanner('Configuration invalid. See the message under the form.', 'err'); render(); return false; }
    state.config = res.cfg;
    if (!quiet) { log('Configuration applied: pool ' + res.cfg.poolName + ', server ' + ipStr(res.cfg.server) + ', first client ' + ipStr(res.cfg.start) + '.', 'success'); setBanner('Configuration applied.', 'ok'); }
    render(); return true;
  }
  function fail(message, stageDone) {
    clearTimer();
    state.status = 'failed'; state.stage = stageDone; state.offers = [null, null, null];
    log(message, 'error'); setBanner(message, 'err'); setExplain(message);
    render();
  }
  function beginExchange() {
    if (!applyConfig(true)) return false;
    state.leases = [null, null, null]; state.offers = [null, null, null]; state.stage = 0;
    log('Starting a new DHCP exchange for ' + PCS.join(', ') + '.', 'info');
    return true;
  }
  function doStage() {              // runs the next DORA stage
    const cfg = state.config, next = state.stage + 1;
    if (next === 2 || next === 4) {
      if (!state.serverOn) { fail('No ' + STAGES[next].name + ' received: the DHCP server is OFF. Turn it ON and try again.', next - 1); return false; }
    }
    state.stage = next;
    setExplain(STAGES[next].text);
    setBanner(STAGES[next].name + (next % 2 ? ': clients → server (broadcast)' : ': server → clients'), '');
    if (next === 1) PCS.forEach((pc) => log(pc + ': DHCPDISCOVER sent (broadcast).', 'info'));
    if (next === 2) {
      const pool = allocate(cfg, PCS.length);
      if (!pool) { fail('DHCP pool exhausted: no free addresses to offer.', 1); return false; }
      state.offers = pool;
      PCS.forEach((pc, i) => log(pc + ': DHCPOFFER received, offered ' + ipStr(pool[i]) + '.', 'info'));
    }
    if (next === 3) PCS.forEach((pc, i) => log(pc + ': DHCPREQUEST sent for ' + ipStr(state.offers[i]) + '.', 'info'));
    if (next === 4) {
      PCS.forEach((pc, i) => {
        state.leases[i] = { ip: state.offers[i], mask: cfg.mask, gateway: cfg.gateway, dns: cfg.dns, hours: cfg.leaseHours };
        log(pc + ': DHCPACK received.', 'success');
        log(pc + ': IP address ' + ipStr(state.offers[i]) + ' assigned (lease ' + cfg.leaseHours + ' h).', 'success');
      });
      state.status = 'complete'; setBanner('DHCP complete: all three clients have unique IP addresses.', 'ok');
    }
    render(); return true;
  }
  function autoTick() {
    state.timer = null;
    if (state.status !== 'auto') return;
    if (!doStage()) return;
    if (state.status === 'auto') state.timer = setTimeout(autoTick, AUTO_DELAY_MS);
  }
  function onRun() {
    if (state.status === 'auto') return;
    clearTimer();
    if (!beginExchange()) return;
    state.status = 'auto'; render();
    autoTick();                                   // stage 1 immediately, the rest on a timer
  }
  function onNext() {
    if (state.status === 'auto') return;
    if (state.status !== 'manual') { clearTimer(); if (!beginExchange()) return; state.status = 'manual'; }
    doStage();
    if (state.status === 'manual' && state.stage === 4) state.status = 'complete';
    render();
  }
  function onReset() {
    clearTimer();
    state.leases = [null, null, null]; state.offers = [null, null, null];
    state.stage = 0; state.status = 'idle';
    showErrors([], []);
    setBanner('Simulation reset. Clients are waiting for an IP address.', ''); setExplain('No exchange in progress. Press “Run DHCP (DORA)” for the automatic demo or “Next Step” to go one stage at a time.');
    $('ping-out').textContent = 'No test run yet. This is a simulation; no ICMP packets are sent.';
    log('Simulation reset.', 'info'); render();
  }
  function onPower() {
    state.serverOn = !state.serverOn;
    log('DHCP server switched ' + (state.serverOn ? 'ON.' : 'OFF.'), state.serverOn ? 'success' : 'error');
    if (!state.serverOn && (state.status === 'auto' || state.status === 'manual')) {
      fail('DHCP server switched OFF during the exchange. The sequence was stopped.', state.stage);
    } else {
      setBanner('DHCP server is ' + (state.serverOn ? 'ON.' : 'OFF. New requests will fail.'), state.serverOn ? 'ok' : 'err');
      render();
    }
  }

  /* ---------- Simulated ping ---------- */
  function fillPingMenus() {
    ['ping-src', 'ping-dst'].forEach((id, k) => {
      const sel = $(id); sel.textContent = '';
      PCS.forEach((pc, i) => { const o = document.createElement('option'); o.value = i; o.textContent = pc; sel.appendChild(o); });
      sel.value = String(k);
    });
    syncPing();
  }
  function syncPing() {
    const s = $('ping-src'), d = $('ping-dst');
    if (s.value === d.value) d.value = String((Number(s.value) + 1) % PCS.length);
    [...s.options].forEach((o) => { o.disabled = o.value === d.value; });
    [...d.options].forEach((o) => { o.disabled = o.value === s.value; });
  }
  function onPing() {
    const a = Number($('ping-src').value), b = Number($('ping-dst').value), out = $('ping-out');
    if (a === b) { out.textContent = 'Choose two different computers.'; return; }
    const A = state.leases[a], B = state.leases[b];
    let msg, type;
    if (!A || !B) {
      msg = 'Ping failed: ' + (!A ? PCS[a] : PCS[b]) + ' has no IP address yet. Run DHCP first.'; type = 'error';
    } else if (A.ip === B.ip) {
      msg = 'Ping failed: both computers report the same IP address (' + ipStr(A.ip) + ').'; type = 'error';
    } else if (((A.ip & A.mask) >>> 0) !== ((B.ip & B.mask) >>> 0)) {
      msg = 'Ping failed: ' + PCS[a] + ' and ' + PCS[b] + ' are on different subnets and no router is present.'; type = 'error';
    } else {
      msg = 'Simulated ping from ' + PCS[a] + ' (' + ipStr(A.ip) + ') to ' + PCS[b] + ' (' + ipStr(B.ip) + ')\n' +
            'Packets: transmitted = 4, received = 4, loss = 0%\n(Simulation only: no real ICMP packets were sent.)'; type = 'success';
    }
    out.textContent = msg;
    log(msg.split('\n').slice(0, 2).join(' – '), type);
  }

  /* ---------- Wiring ---------- */
  $('btn-apply').addEventListener('click', () => applyConfig(false));
  $('btn-run').addEventListener('click', onRun);
  $('btn-next').addEventListener('click', onNext);
  $('btn-reset').addEventListener('click', onReset);
  $('btn-power').addEventListener('click', onPower);
  $('btn-ping').addEventListener('click', onPing);
  $('btn-clear').addEventListener('click', () => { $('log').textContent = ''; });
  $('ping-src').addEventListener('change', syncPing);
  $('ping-dst').addEventListener('change', () => { const s = $('ping-src'), d = $('ping-dst'); if (s.value === d.value) s.value = String((Number(d.value) + 1) % PCS.length); syncPing(); });
  $('cfg-form').addEventListener('submit', (e) => e.preventDefault());

  fillPingMenus();
  log('DHCP server initialized.', 'success');
  applyConfig(false);
  render();
})();
