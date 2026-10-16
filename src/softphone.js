// src/softphone.js — the desk's own phone, inside the office page.
//
// This is the piece the office has to get right: a Plivo SIP endpoint registered in
// the browser, so a human can talk to the guest through the app instead of the server playing a script.
//
// Call control stays with OUR server on purpose:
//   POST /api/plivo/call { to, mode:'browser' }  ->  our answer XML bridges the guest to
//   <Dial><User>sip:…</User></Dial>              ->  this browser receives that leg (onIncomingCall)
// That way a call never depends on an Application being attached to the Plivo endpoint, and the same
// XML we verified back on the server is what drives the conversation.
//
// Two modes: "talk" (human answers and speaks) and "message" (Plivo greets, records, hangs up).

const SDK_SRC = 'https://cdn.plivo.com/sdk/browser/v2/plivo.min.js';

export function initSoftphone({ api = '/api' } = {}) {
  if (window.__softphone) return window.__softphone;          // init once

  const state = {
    sdkLoaded: false, registered: false, registerError: null,
    username: null, callerId: null, mode: 'talk',
    call: null, callSince: null, muted: false, incoming: null,
    last: null, log: [],
  };
  let client = null;
  let tickTimer = null;

  /* ── the shim Plivo needs ─────────────────────────────────────────────────────────────────────
     Plivo's SDK calls this.noiseSuppresion.startNoiseSuppression() unconditionally; if it has not been
     initialised it throws and the call connects with no audio. */
  function patchSdk(PlivoClass, instance) {
    const shim = {
      noiseSupressionRunning: false, started: false,
      startNoiseSuppression: async () => window.localStream || null,
      stopNoiseSuppresion: () => {}, stopNoiseSuppression: () => {},
      setLocalMediaStream: async () => window.localStream || null,
      updateProcessingStream: async s => s, clearNoiseSupression: () => {}, clearNoiseSuppression: () => {},
      muteStream: () => {}, unmuteStream: () => {},
      startNoiseSuppresionManual: async () => false, stopNoiseSuppressionManual: async () => false,
      client: instance,
    };
    const targets = [];
    if (PlivoClass?.Client?.prototype) targets.push(PlivoClass.Client.prototype);
    if (PlivoClass?.prototype) targets.push(PlivoClass.prototype);
    if (instance) targets.push(instance);
    for (const t of targets) for (const p of ['noiseSuppresion', 'noiseSuppression']) {
      try {
        Object.defineProperty(t, p, { get() { return this[`_${p}_shim`] || (this[`_${p}_shim`] = shim); }, set(v) { this[`_${p}_shim`] = v; }, configurable: true });
      } catch { /* not patchable, move on */ }
    }
  }

  const say = (msg) => { state.log.unshift(`${new Date().toLocaleTimeString()}  ${msg}`); state.log = state.log.slice(0, 40); draw(); };

  function loadSdk() {
    if (state.sdkLoaded) return Promise.resolve(window.Plivo);
    return new Promise((resolve, reject) => {
      if (window.Plivo) { state.sdkLoaded = true; return resolve(window.Plivo); }
      const s = document.createElement('script');
      s.src = SDK_SRC; s.async = true;
      s.onload = () => { state.sdkLoaded = !!window.Plivo; state.sdkLoaded ? resolve(window.Plivo) : reject(new Error('SDK loaded but window.Plivo missing')); };
      s.onerror = () => reject(new Error('could not load ' + SDK_SRC));
      document.head.appendChild(s);
    });
  }

  async function register() {
    if (state.registered) return;
    try {
      const cfg = await fetch(`${api}/plivo/endpoint`).then(r => r.json());
      if (!cfg.username) throw new Error(cfg.error || 'no SIP endpoint configured');
      const P = await loadSdk();
      patchSdk(P);
      // This build of the SDK hands you the client off the instance (lowercase `client`), not as a
      // static `Client` constructor; accept either shape so a version bump cannot break the phone.
      const instance = new P({ debug: 'INFO', permOnClick: true, enableNoiseReduction: false });
      const c = instance.client || instance.Client || P.client || P.Client;
      if (!c) throw new Error('Plivo SDK exposed no client');
      client = (typeof c === 'function') ? new c({ enableNoiseReduction: false }) : c;
      patchSdk(P, client);

      client.on('onLogin', () => { state.registered = true; state.registerError = null; state.username = cfg.username; say(`line registered as ${cfg.username}`); });
      client.on('onLoginFailed', (c) => { state.registered = false; state.registerError = String(c?.reason || c || 'login failed'); say('line failed: ' + state.registerError); });
      client.on('onIncomingCall', (call) => incoming(call));
      client.on('incomingCall', (call) => incoming(call));
      client.on('onIncomingCallHangup', () => { state.incoming = null; say('the call leg ended'); draw(); });
      client.on('onCallAnswered', () => say('answered — you are live with the guest'));
      client.on('onCallConnected', () => say('audio connected'));
      client.on('onCallTerminated', () => { if (state.call) say('call ended'); state.call = null; state.callSince = null; stopTick(); draw(); });
      client.on('onCallFailed', (c) => say('call failed: ' + String(c?.reason || c)));

      state.username = cfg.username;
      client.login(cfg.username, cfg.password);
      say('registering the line…');
    } catch (e) {
      state.registerError = e.message; say('could not register: ' + e.message); draw();
    }
  }

  function incoming(call) {
    state.incoming = call || true;
    say('guest is connected — picking up');
    try { client.answer(); } catch (e) { say('answer failed: ' + e.message); }
    draw();
  }

  async function status() {
    try { return await fetch(`${api}/plivo/status`).then(r => r.json()); } catch { return null; }
  }

  /** Place a call. mode 'talk' bridges the guest to this browser; 'message' greets and records. */
  async function call(to, mode = state.mode) {
    if (!to) { say('give me a number to dial'); return null; }
    await register();
    if (mode === 'talk' && !state.registered) { say('the line is not registered yet — cannot talk'); return null; }
    try {
      const r = await fetch(`${api}/plivo/call`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, mode: mode === 'talk' ? 'browser' : 'auto' }),
      });
      const j = await r.json();
      if (!r.ok) { say('refused: ' + (j.error || r.status)); return null; }
      state.call = j.requestUuid || 'queued'; state.callSince = Date.now(); state.last = { ...j, mode, to };
      say(`dialing ${to} (${mode === 'talk' ? 'you will speak' : 'message, will be recorded'})`);
      if (mode === 'message') { stopTick(); }
      startTick();
      draw();
      return j;
    } catch (e) { say('dial failed: ' + e.message); return null; }
  }

  function hangup() {
    try { client?.hangup(); } catch { /* nothing live */ }
    state.call = null; state.callSince = null; state.muted = false;
    stopTick(); say('hung up'); draw();
  }
  function mute() {
    try { client?.mute(); } catch { /* nothing live */ }
    state.muted = !state.muted; say(state.muted ? 'muted' : 'unmuted'); draw();
  }
  function reject() { try { client?.reject?.(); } catch { /* ignore */ } state.incoming = null; say('rejected the leg'); draw(); }

  const startTick = () => { stopTick(); tickTimer = setInterval(() => { const el = document.querySelector('#spTimer'); if (el && state.callSince) el.textContent = clock(); }, 1000); };
  const stopTick = () => { if (tickTimer) clearInterval(tickTimer); tickTimer = null; };
  const clock = () => { const s = Math.max(0, Math.floor((Date.now() - state.callSince) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

  /* ── the UI ──────────────────────────────────────────────────────────────────────────────────── */
  const css = `#spBtn{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 13px;margin-left:8px;border-radius:999px;border:1px solid rgba(14,155,143,.45);background:linear-gradient(180deg,#12b1a3,#0e9b8f);color:#fff;font:600 11px/1 var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",sans-serif);letter-spacing:.06em;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.15)}
#spBtn:hover{filter:brightness(1.06)}
#spBtn .dotx{width:7px;height:7px;border-radius:50%;background:#c8f7f1;box-shadow:0 0 0 2px rgba(255,255,255,.35)}
#spBtn.live .dotx{background:#34d399;animation:spPulse 1.2s infinite}
@keyframes spPulse{0%,100%{opacity:1}50%{opacity:.35}}
#spOv{position:fixed;inset:0;z-index:90;display:none;background:rgba(12,16,22,.42);backdrop-filter:blur(3px)}
#spOv.open{display:block}
#spPanel{position:absolute;right:22px;top:64px;width:400px;max-width:calc(100vw - 44px);background:#fff;border-radius:16px;box-shadow:0 24px 70px rgba(10,20,30,.34);overflow:hidden;font:13px/1.5 var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",sans-serif);color:#1c232b}
#spPanel h3{margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#0e9b8f;font-family:var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",sans-serif)}
#spHead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid #eef1f4}
#spHead button{border:1px solid #d8dee5;background:#fff;border-radius:8px;height:28px;padding:0 10px;font:600 11px var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",sans-serif);cursor:pointer;color:#475569}
#spBody{padding:14px 16px}
.sprow{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.sprow label{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#64748b;min-width:64px;font-family:var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",sans-serif)}
#spNum{flex:1;height:36px;border:1px solid #d8dee5;border-radius:10px;padding:0 11px;font:13px var(--font-mono,"SF Mono",Menlo,Consolas,monospace)}
.spbtn{height:36px;border:0;border-radius:10px;padding:0 14px;font:600 12px var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",sans-serif);cursor:pointer;color:#fff;background:#0e9b8f}
.spbtn.alt{background:#1f2937}
.spbtn.warn{background:#dc2626}
.spbtn.ghost{background:#f1f5f9;color:#334155}
.spbtn:disabled{opacity:.5;cursor:not-allowed}
#spLine{display:flex;align-items:center;gap:8px;padding:10px 16px;background:#f8fafc;border-bottom:1px solid #eef1f4;font-size:12px;color:#475569;font-family:var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",sans-serif)}
#spLine .pip{width:8px;height:8px;border-radius:50%;background:#cbd5e1}
#spLine.ok .pip{background:#10b981}
#spLine.bad .pip{background:#ef4444}
#spCallbar{display:none;align-items:center;gap:10px;margin:10px 0;padding:10px 12px;border:1px solid #a7f3d0;background:#ecfdf5;border-radius:12px}
#spCallbar.on{display:flex}
#spTimer{font:700 15px var(--font-mono,"SF Mono",Menlo,Consolas,monospace);color:#065f46;min-width:56px}
#spIncoming{display:none;margin:10px 0;padding:10px 12px;border:1px solid #fcd34d;background:#fffbeb;border-radius:12px}
#spIncoming.on{display:block}
#spLog{margin-top:12px;max-height:132px;overflow:auto;border-top:1px dashed #e2e8f0;padding-top:8px;font:11px/1.6 var(--font-mono,"SF Mono",Menlo,Consolas,monospace);color:#64748b;white-space:pre-wrap}
.spmeta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.spmeta span{font:11px var(--font-mono,"SF Mono",Menlo,Consolas,monospace);background:#f1f5f9;border-radius:6px;padding:2px 7px;color:#475569}
select#spMode{height:36px;border:1px solid #d8dee5;border-radius:10px;background:#fff;padding:0 8px;font:12px var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",sans-serif)}`;

  function shell() {
    if (document.getElementById('spOv')) return;
    const st = document.createElement('style'); st.id = 'spCss'; st.textContent = css; document.head.appendChild(st);
    const ov = document.createElement('div');
    ov.id = 'spOv';
    ov.innerHTML = `<div id="spPanel">
      <div id="spHead"><h3>Holiday Desk · Phone</h3><button id="spClose">Close</button></div>
      <div id="spLine"><span class="pip"></span><span id="spLineTxt">checking the line…</span></div>
      <div id="spBody">
        <div class="spmeta" id="spMeta"></div>
        <div class="sprow" style="margin-top:12px">
          <label>Number</label>
          <input id="spNum" placeholder="+91…" inputmode="tel">
        </div>
        <div class="sprow">
          <label>Mode</label>
          <select id="spMode">
            <option value="talk">talk in browser (I speak)</option>
            <option value="message">message (greet + record)</option>
          </select>
        </div>
        <div class="sprow" style="gap:8px">
          <button class="spbtn" id="spCall" style="flex:1">Call</button>
          <button class="spbtn ghost" id="spMute" disabled>Mute</button>
          <button class="spbtn warn" id="spHang" disabled>Hang up</button>
        </div>
        <div id="spIncoming"><b>Guest on the line.</b> <span id="spIncTxt">picking up…</span>
          <div style="margin-top:8px;display:flex;gap:8px"><button class="spbtn" id="spAns">Answer</button><button class="spbtn ghost" id="spRej">Reject</button></div>
        </div>
        <div id="spCallbar"><span id="spTimer">00:00</span><span id="spCallTxt">on the line</span>
          <span style="flex:1"></span><button class="spbtn ghost" id="spMute2" style="height:30px">Mute</button><button class="spbtn warn" id="spHang2" style="height:30px">Hang up</button>
        </div>
        <div id="spLog"></div>
      </div></div>`;
    document.body.appendChild(ov);

    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    document.getElementById('spClose').onclick = close;
    document.getElementById('spCall').onclick = () => call(document.getElementById('spNum').value.trim());
    document.getElementById('spHang').onclick = hangup;
    document.getElementById('spHang2').onclick = hangup;
    document.getElementById('spMute').onclick = mute;
    document.getElementById('spMute2').onclick = mute;
    document.getElementById('spAns').onclick = () => incoming(state.incoming);
    document.getElementById('spRej').onclick = reject;
    document.getElementById('spMode').onchange = e => { state.mode = e.target.value; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  function draw() {
    const ov = document.getElementById('spOv'); if (!ov) return;
    const line = document.getElementById('spLine');
    const txt = document.getElementById('spLineTxt');
    line.className = state.registered ? 'ok' : (state.registerError ? 'bad' : '');
    txt.textContent = state.registered ? `line registered · ${state.username}`
      : (state.registerError ? `line down · ${state.registerError}` : 'registering the line…');
    const el = id => document.getElementById(id);
    el('spLog').textContent = state.log.join('\n');
    el('spCallbar').className = state.call ? 'on' : '';
    el('spIncoming').className = state.incoming ? 'on' : '';
    el('spTimer').textContent = state.callSince ? clock() : '00:00';
    el('spHang').disabled = el('spHang2').disabled = !state.call;
    el('spMute').disabled = el('spMute2').disabled = !state.call;
    el('spMute').textContent = state.muted ? 'Unmute' : 'Mute';
    el('spMute2').textContent = state.muted ? 'Unmute' : 'Mute';
    const meta = [];
    if (state.username) meta.push(`sip ${state.username}`);
    if (state.callerId) meta.push(`from ${state.callerId}`);
    if (state.info?.account?.credits) meta.push(`credit $${state.info.account.credits}`);
    if (state.info?.webhook) meta.push(`webhook ${state.info.webhook.ok ? 'live' : 'not reachable'}`);
    el('spMeta').innerHTML = meta.map(m => `<span>${m}</span>`).join('');
  }

  async function open() {
    shell();
    document.getElementById('spOv').classList.add('open');
    const info = await status();
    if (info) { state.info = info; state.callerId = info.callerId; if (!state.username && info.account) state.username = info.username || state.username; }
    draw();
    if (!state.registered && !state.registerError) register();
  }
  const close = () => document.getElementById('spOv').classList.remove('open');

  // the header button, sat beside the Enquiry Desk button
  function mountButton() {
    if (document.getElementById('spBtn')) return;
    const b = document.createElement('button');
    b.id = 'spBtn'; b.innerHTML = '<span class="dotx"></span>PHONE';
    b.title = 'Holiday desk phone — call the guest from here';
    b.onclick = open;
    const bar = document.getElementById('topbar');
    const clock = document.getElementById('clock');
    if (bar) bar.insertBefore(b, clock || null);
    else document.body.appendChild(b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountButton); else mountButton();

  const api2 = { open, close, call, hangup, mute, reject, register, status: () => ({ ...state }), client: () => client };
  window.__softphone = api2;
  return api2;
}
