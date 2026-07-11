/** Control panel: single static dark page, vanilla JS, no build step. */
export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>botty sim</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0f1115; color: #d7dae0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { display: flex; align-items: baseline; gap: 16px; padding: 12px 16px; border-bottom: 1px solid #23262e; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; color: #e8eaf0; }
  #clock { font-size: 15px; color: #7ee787; }
  #status { color: #8b93a3; }
  main { display: grid; grid-template-columns: 320px 1fr; gap: 0; min-height: calc(100vh - 46px); }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  aside { border-right: 1px solid #23262e; padding: 14px 16px; }
  section.panel { margin-bottom: 22px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #8b93a3; margin: 0 0 8px; }
  select, input, textarea, button { background: #171a21; color: #d7dae0; border: 1px solid #2c313c; border-radius: 4px; padding: 5px 8px; font: inherit; }
  select:focus, input:focus, textarea:focus { outline: 1px solid #4a7dff; }
  button { cursor: pointer; }
  button:hover { background: #202531; }
  button.primary { border-color: #345; background: #1b2a3d; color: #9ecbff; }
  .row { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; align-items: center; }
  .row label { color: #8b93a3; min-width: 52px; }
  input[type=number] { width: 70px; }
  textarea { width: 100%; min-height: 56px; resize: vertical; }
  #people { color: #8b93a3; white-space: pre-line; }
  .timeline { padding: 14px 16px; overflow-x: auto; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 1100px) { .cols { grid-template-columns: 1fr; } }
  ul.events { list-style: none; margin: 0; padding: 0; max-height: 72vh; overflow-y: auto; }
  ul.events li { padding: 6px 8px; border-bottom: 1px solid #1b1e26; display: flex; gap: 8px; align-items: baseline; }
  .badge { flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 3px; text-transform: uppercase; }
  .b-slack { background: #3b2a4d; color: #d3b4ff; } .b-gmail { background: #4d2a2a; color: #ffb4b4; }
  .b-gcal { background: #2a3d4d; color: #9ecbff; } .b-jira { background: #2a4d3b; color: #a3ffce; }
  .b-github { background: #3d3d2a; color: #f0e6a3; }
  .time { color: #6d7689; flex: 0 0 auto; }
  .who { color: #c7a4ff; flex: 0 0 auto; }
  .txt { color: #c8ccd4; overflow-wrap: anywhere; }
  #msg { color: #ffb86c; min-height: 1.2em; margin-top: 6px; overflow-wrap: anywhere; }
  .count { color: #8b93a3; font-weight: normal; }
</style>
</head>
<body>
<header>
  <h1>botty sim</h1>
  <span id="clock">--:--</span>
  <span id="status">no scenario</span>
</header>
<main>
  <aside>
    <section class="panel">
      <h2>Scenario</h2>
      <div class="row">
        <select id="scenarioSel"></select>
        <button id="loadBtn" class="primary">Load</button>
        <button id="resetBtn">Reset</button>
      </div>
    </section>
    <section class="panel">
      <h2>Playback</h2>
      <div class="row">
        <button id="playBtn" class="primary">Play</button>
        <button id="pauseBtn">Pause</button>
        <label>speed</label><input id="speed" type="number" value="60" min="1">
      </div>
      <div class="row">
        <button id="advBtn">Advance</button>
        <input id="advMin" type="number" value="15" min="0"> <span>min</span>
      </div>
    </section>
    <section class="panel">
      <h2>Inject</h2>
      <div class="row"><label>tmpl</label><select id="tmplSel"><option value="">— template —</option></select></div>
      <div class="row"><label>source</label>
        <select id="injSource"><option>slack</option><option>gmail</option><option>gcal</option><option>jira</option><option>github</option></select>
        <input id="injKind" placeholder="kind (dm/email/…)" style="width:110px">
      </div>
      <div class="row"><label>handle</label><input id="injHandle" placeholder="@marian" style="width:90px">
        <label>email</label><input id="injEmail" placeholder="a@b.com" style="width:120px"></div>
      <div class="row"><textarea id="injText" placeholder="text"></textarea></div>
      <div class="row"><label>meta</label><textarea id="injMeta" placeholder='{"key":"…"} (JSON, optional)' style="min-height:36px"></textarea></div>
      <div class="row"><button id="injBtn" class="primary">Inject now</button></div>
      <div id="msg"></div>
    </section>
    <section class="panel">
      <h2>People</h2>
      <div id="people">—</div>
    </section>
  </aside>
  <div class="timeline">
    <div class="cols">
      <section>
        <h2>Released <span class="count" id="relCount"></span></h2>
        <ul class="events" id="released"></ul>
      </section>
      <section>
        <h2>Pending <span class="count" id="pendCount"></span></h2>
        <ul class="events" id="pending"></ul>
      </section>
    </div>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let templates = [];

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function flash(text) { $('msg').textContent = text; if (text) setTimeout(() => { if ($('msg').textContent === text) $('msg').textContent = ''; }, 5000); }

function esc(s) { const d = document.createElement('span'); d.textContent = s ?? ''; return d.innerHTML; }
function who(a) { return a ? (a.handle || a.email || a.displayName || '') : ''; }
function hhmm(iso) { return iso ? iso.slice(11, 16) : ''; }

function render(st) {
  const c = st.clock;
  $('clock').textContent = c.simNow ? c.simNow.replace('T', ' ').slice(0, 16) + '  (t+' + Math.floor(c.minutes) + 'm)' : '--:--';
  $('status').textContent = (st.scenario ? st.scenario.name : 'no scenario') + (c.playing ? ' · playing ×' + c.speed : ' · paused');
  const sel = $('scenarioSel');
  const names = st.available || [];
  if (sel.dataset.names !== names.join(',')) {
    sel.dataset.names = names.join(',');
    sel.innerHTML = names.map((n) => '<option>' + esc(n) + '</option>').join('');
  }
  $('relCount').textContent = '(' + st.released.length + ')';
  $('pendCount').textContent = '(' + st.pending.length + ')';
  $('released').innerHTML = st.released.slice().reverse().map((e) =>
    '<li><span class="time">' + hhmm(e.occurredAt) + '</span><span class="badge b-' + e.source + '">' + e.source +
    '</span><span class="who">' + esc(who(e.actor)) + '</span><span class="txt">' + esc(e.text) + '</span></li>').join('');
  $('pending').innerHTML = st.pending.map((e) =>
    '<li><span class="time">t+' + e.atMinute + 'm</span><span class="badge b-' + e.source + '">' + e.source +
    '</span><span class="who">' + esc(who(e.actor)) + '</span><span class="txt">' + esc(e.text) + '</span></li>').join('');
  $('people').textContent = (st.people || []).map((p) => p.name + ' ' + (p.slackHandle || '') + ' ' + (p.email || '')).join('\\n') || '—';
}

async function refresh() { try { render(await api('/control/state')); } catch (e) { $('status').textContent = 'sim unreachable'; } }

async function loadTemplates() {
  try {
    templates = (await api('/control/templates')).templates || [];
    $('tmplSel').innerHTML = '<option value="">— template —</option>' +
      templates.map((t, i) => '<option value="' + i + '">' + esc(t.label) + '</option>').join('');
  } catch (e) { /* ignore */ }
}

// Template fields with no form input (threadRef, direction, actor displayName) ride along on inject.
let tmplExtra = {};
$('tmplSel').onchange = () => {
  const v = $('tmplSel').value;
  // '' is the "— template —" placeholder; Number('') === 0 would otherwise reload templates[0].
  if (v === '') { tmplExtra = {}; return; }
  const t = templates[Number(v)];
  if (!t) { tmplExtra = {}; return; }
  $('injSource').value = t.event.source;
  $('injKind').value = t.event.kind;
  $('injHandle').value = (t.event.actor && t.event.actor.handle) || '';
  $('injEmail').value = (t.event.actor && t.event.actor.email) || '';
  $('injText').value = t.event.text;
  $('injMeta').value = t.event.meta ? JSON.stringify(t.event.meta) : '';
  tmplExtra = {};
  if (t.event.threadRef) tmplExtra.threadRef = t.event.threadRef;
  if (t.event.direction) tmplExtra.direction = t.event.direction;
  if (t.event.actor && t.event.actor.displayName) tmplExtra.displayName = t.event.actor.displayName;
};

$('loadBtn').onclick = async () => {
  try { await api('/control/scenario/load', { name: $('scenarioSel').value }); await loadTemplates(); flash('loaded'); }
  catch (e) { flash(e.message); } refresh();
};
$('resetBtn').onclick = async () => { try { await api('/control/reset', {}); flash('reset'); } catch (e) { flash(e.message); } refresh(); };
$('playBtn').onclick = async () => { try { await api('/control/scenario/play', { speed: Number($('speed').value) || 60 }); } catch (e) { flash(e.message); } refresh(); };
$('pauseBtn').onclick = async () => { try { await api('/control/scenario/pause', {}); } catch (e) { flash(e.message); } refresh(); };
$('advBtn').onclick = async () => { try { await api('/control/advance', { minutes: Number($('advMin').value) || 0 }); } catch (e) { flash(e.message); } refresh(); };

$('injBtn').onclick = async () => {
  try {
    const actor = {};
    if ($('injHandle').value) actor.handle = $('injHandle').value;
    if ($('injEmail').value) actor.email = $('injEmail').value;
    if (tmplExtra.displayName) actor.displayName = tmplExtra.displayName;
    const body = { source: $('injSource').value, kind: $('injKind').value || 'dm', actor, text: $('injText').value };
    if (tmplExtra.threadRef) body.threadRef = tmplExtra.threadRef;
    if (tmplExtra.direction) body.direction = tmplExtra.direction;
    if ($('injMeta').value.trim()) body.meta = JSON.parse($('injMeta').value);
    const r = await api('/control/inject', body);
    // Reset template linkage after every inject: a hand-typed follow-up (no re-selection)
    // must never inherit a stale threadRef/direction/displayName from a prior template.
    tmplExtra = {};
    $('tmplSel').value = '';
    flash('injected ' + r.event.externalId);
  } catch (e) { flash(e.message); }
  refresh();
};

loadTemplates();
refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>
`;
