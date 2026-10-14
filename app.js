import { prepareEvent, isActive } from './routing.js';
import { buildNetwork, route as routeOnNet, laterDeparture } from './graph.js';

const PHOTON = 'https://photon.komoot.io';
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const state = { ev: null, net: null, from: null, to: null, mode: 'auto', run: 0 };

// ---------- karta ----------

const map = L.map('map', { zoomControl: false }).setView([46.056, 14.505], 13);
L.control.zoom({ position: 'topright', zoomInTitle: 'Povečaj', zoomOutTitle: 'Pomanjšaj' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layers = {
  closures: L.layerGroup().addTo(map),
  baseline: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  conflicts: L.layerGroup().addTo(map),
};
const pin = (color, radius) => L.divIcon({
  className: '', iconSize: [24, 24], iconAnchor: [12, 12],
  html: `<div style="width:24px;height:24px;border-radius:${radius};background:${color};border:4px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.4)"></div>`,
});
const markers = {
  from: L.marker([0, 0], { draggable: true, icon: pin(css('--from'), '50%') }),
  to: L.marker([0, 0], { draggable: true, icon: pin(css('--to'), '6px') }),
};
for (const k of ['from', 'to']) {
  markers[k].on('dragend', async (e) => {
    const { lat, lng } = e.target.getLatLng();
    await setPlace(k, [lng, lat], null);
  });
}

map.on('click', (e) => {
  const k = !state.from ? 'from' : !state.to ? 'to' : 'to';
  setPlace(k, [e.latlng.lng, e.latlng.lat], null);
});

// ---------- čas ----------

const departMs = () => Date.parse(`${$('day').value}T${$('time').value || '00:00'}`);
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => new Date(d + 'T12:00').toLocaleDateString('sl-SI', { weekday: 'short', day: 'numeric', month: 'numeric' });
const fmtDur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const hhmm = (iso) => iso.slice(11, 16);

// opened: zapore, ki se na izbrani poti odprejo, preden pridemo do njih
function drawClosures(opened = []) {
  const t = departMs(), openedAt = new Map(opened.map((o) => [o.closure, o.atMs]));
  layers.closures.clearLayers();
  let n = 0;
  // neaktivne spodaj, aktivne zgoraj
  const sorted = [...state.ev.closures].sort((a, b) => isActive(a, t, t + 1) - isActive(b, t, t + 1));
  for (const c of sorted) {
    const on = isActive(c, t, t + 1), at = openedAt.get(c); n += on;
    const show = on && !at;
    L.polyline(c.coords.map(([x, y]) => [y, x]), {
      color: show ? css('--closed') : css('--closed-off'), weight: show ? 6 : 3.5, opacity: show ? .9 : .75,
      dashArray: show ? null : '4 6',
    }).bindTooltip(`<b>${c.name}</b><br>${c.note || ''}<br>Zaprto ${hhmm(c.start)}–${hhmm(c.end)}${at ? `<br>Ko prideš sem (~${fmtTime(at)}), bo že odprto.` : ''}`, { sticky: true })
      .addTo(layers.closures);
  }
  $('activeCount').textContent = n
    ? `Ob ${$('time').value} je zaprtih ${n} odsekov.`
    : `Ob ${$('time').value} zaradi dogodka ni zapor.`;
}

// ---------- iskanje naslovov ----------

function placeLabel(p) {
  const a = p.properties;
  const street = [a.street, a.housenumber].filter(Boolean).join(' ');
  const main = a.name || street || a.city || 'Točka';
  const rest = [a.name && street, a.district || a.locality, a.city].filter(Boolean).filter((x) => x !== main);
  return { main, rest: [...new Set(rest)].join(', ') };
}

function setupSearch(k) {
  const input = $(k);
  let list = null, items = [], sel = -1, timer = null, ctrl = null;
  const close = () => { list?.remove(); list = null; sel = -1; };
  const pick = (i) => {
    const p = items[i]; if (!p) return;
    const { main, rest } = placeLabel(p);
    close(); setPlace(k, p.geometry.coordinates, rest ? `${main}, ${rest}` : main);
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = setTimeout(async () => {
      ctrl?.abort(); ctrl = new AbortController();
      const [lon, lat] = state.ev.meta.center;
      try {
        const r = await fetch(`${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&lat=${lat}&lon=${lon}&location_bias_scale=0.5`, { signal: ctrl.signal });
        items = (await r.json()).features || [];
      } catch { return; }
      close();
      if (!items.length) return;
      list = document.createElement('ul'); list.className = 'sugg';
      items.forEach((p, i) => {
        const { main, rest } = placeLabel(p);
        const li = document.createElement('li');
        li.innerHTML = `${main}${rest ? `<small>${rest}</small>` : ''}`;
        li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
        list.appendChild(li);
      });
      input.parentElement.appendChild(list);
    }, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (!list) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      [...list.children].forEach((li, i) => li.classList.toggle('on', i === sel));
    } else if (e.key === 'Enter') { e.preventDefault(); pick(sel < 0 ? 0 : sel); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

async function reverseLabel([lon, lat]) {
  try {
    const r = await fetch(`${PHOTON}/reverse?lon=${lon}&lat=${lat}&limit=1`);
    const p = (await r.json()).features?.[0];
    if (p) { const { main, rest } = placeLabel(p); return rest ? `${main}, ${rest}` : main; }
  } catch {}
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

async function setPlace(k, coords, label) {
  state[k] = coords;
  markers[k].setLatLng([coords[1], coords[0]]).addTo(map);
  $(k).value = label ?? '…';
  route();
  if (label == null) $(k).value = await reverseLabel(coords);
}

// ---------- usmerjanje ----------

function route() {
  if (!state.from || !state.to || !state.net) return;
  const run = ++state.run;
  const opts = { from: state.from, to: state.to, departMs: departMs(), costing: state.mode };
  $('result').innerHTML = '<div class="loading"><span class="spinner"></span>Računam pot …</div>';
  // izračun je sinhron (~50 ms); setTimeout pusti brskalniku, da izriše »računam«
  setTimeout(() => {
    if (run !== state.run) return;
    const baseline = routeOnNet(state.net, state.ev, { ...opts, closures: false });
    const r = routeOnNet(state.net, state.ev, opts);
    const later = r ? null : laterDeparture(state.net, state.ev, opts);
    const leave = r?.waits.length ? leaveWhenOpen(opts, r) : null;
    render({ route: r, baseline, later, leave });
  }, 10);
}

// Pot s čakanjem pred zaporo ob izbrani uri v resnici ni mogoča: poišči odhod,
// pri katerem so zapore na poti že odprte (odhod zamaknemo za čas čakanja).
function leaveWhenOpen(opts, r) {
  let t = opts.departMs, why = r.waits;
  for (let i = 0; i < 6 && r?.waits.length; i++) {
    why = r.waits;
    t += Math.ceil(r.waitS / 60) * 60000;
    r = routeOnNet(state.net, state.ev, { ...opts, departMs: t });
  }
  return r && !r.waits.length ? { departMs: t, route: r, why } : null;
}

const fmtKm = (km) => `${km.toFixed(1).replace('.', ',')} km`;
const fmtWhen = (ms) => {
  const d = new Date(ms), same = d.toDateString() === new Date(departMs()).toDateString();
  return same ? fmtTime(ms) : `${d.toLocaleDateString('sl-SI', { day: 'numeric', month: 'numeric' })} ${fmtTime(ms)}`;
};

function closuresNear(p, t, r = 120) {
  const [x, y] = state.ev.proj.fwd(p);
  return state.ev.closures.filter((c) => c.startMs <= t && t < c.endMs && c.xy.some(([cx, cy], i) => {
    if (!i) return false;
    const [ax, ay] = c.xy[i - 1], dx = cx - ax, dy = cy - ay, l2 = dx * dx + dy * dy;
    const u = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    return Math.hypot(x - ax - u * dx, y - ay - u * dy) < r;
  }));
}

const ICON = {
  no: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6 L18.4 18.4"/></svg>',
  clock: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7 V12 L15 14"/></svg>',
  arrow: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12 H19 M13 6 L19 12 L13 18"/></svg>',
  ok: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12 L10 17 L19 7"/></svg>',
  waitPin: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7 V12 L15 14"/></svg>',
};

function render({ route: r, baseline, later, leave }) {
  layers.route.clearLayers(); layers.baseline.clearLayers(); layers.conflicts.clearLayers();
  const ll = (c) => c.map(([x, y]) => [y, x]);
  const at = $('time').value;
  const opensTxt = (ws) => [...new Map(ws.map((w) => [w.closure.name, w])).values()]
    .map((w) => `<b>${w.closure.name}</b>${w.street ? ` (${w.street})` : ''} se odpre ob <b>${fmtTime(w.untilMs)}</b>.`).join(' ');
  const cta = (id, small, big) => `<button class="cta" id="${id}"><span><small>${small}</small><b>${big}</b></span>${ICON.arrow}</button>`;

  if (!r) {
    drawClosures();
    if (baseline) L.polyline(ll(baseline.coords), { color: css('--muted'), weight: 4, opacity: .6, dashArray: '2 8' }).addTo(layers.baseline);
    const t = departMs(), near = [state.from, state.to].flatMap((p) => closuresNear(p, t));
    const why = near.length
      ? `Izhodišče ali cilj je ob zaprti cesti: ${[...new Map(near.map((c) => [c.name, c])).values()].map((c) => `<b>${c.name}</b> (do ${fmtWhen(c.endMs)})`).join(', ')}.`
      : `Izhodišče ali cilj je ob ${at} obkrožen z zaporami.`;
    $('result').innerHTML = `<div class="alert">
      <h2>${ICON.no}Ob ${at} poti ni</h2><p>${why}</p>
      ${later ? cta('useLater', 'Prva možnost: odhod ob', `${fmtTime(later.departMs)} → prihod ${fmtTime(later.departMs + later.route.timeS * 1000)}`)
        : '<p>Tudi v naslednjih 8 urah poti nisem našel.</p>'}</div>`;
    if ($('useLater')) $('useLater').onclick = () => { $('time').value = fmtTime(later.departMs); drawClosures(); route(); };
    return;
  }

  // čakanje pred zaporo ponudimo kot možnost le, če pripelje vsaj 10 min prej
  const waitArrive = departMs() + r.timeS * 1000;
  const waitHelps = leave && leave.departMs + leave.route.timeS * 1000 - waitArrive >= 600000;
  const showingWait = leave && waitHelps && state.showWait;
  if (showingWait) leave = null;

  if (leave) {
    // ob izbrani uri poti ni: pokaži le predlog, pot se nariše za predlagani čas
    drawClosures();
    const leaveArrive = leave.departMs + leave.route.timeS * 1000;
    $('result').innerHTML = `<div class="alert">
      <h2>${ICON.no}Ob ${at} pot ni mogoča</h2>
      <p>Pot do cilja je zaprta. ${opensTxt(leave.why)}</p>
      ${cta('useLeave', 'Odpravi se ob', `${fmtTime(leave.departMs)} → prihod ${fmtTime(leaveArrive)}`)}
      ${waitHelps ? `<button class="link" id="showWait">Ali pa pojdi že ob ${at} in počakaj pred zaporo – prihod ob ${fmtTime(waitArrive)}</button>` : ''}</div>`;
    $('useLeave').onclick = () => { state.showWait = false; $('time').value = fmtTime(leave.departMs); drawClosures(); route(); };
    if ($('showWait')) $('showWait').onclick = () => { state.showWait = true; route(); };
    return;
  }

  // zapore, ki so ob prikazani uri aktivne, a se odprejo, preden pridemo do njih
  const tShown = departMs();
  const passOpen = r.crossed.filter((o) => o.closure.startMs <= tShown && tShown < o.closure.endMs
    && !r.waits.some((w) => w.closure === o.closure));
  drawClosures(passOpen);

  const changed = baseline && (Math.abs(r.timeS - baseline.timeS) > 30 || Math.abs(r.lengthKm - baseline.lengthKm) > .1);
  if (changed) L.polyline(ll(baseline.coords), { color: css('--muted'), weight: 4, opacity: .55, dashArray: '2 8' })
    .bindTooltip('Običajna pot (brez zapor)').addTo(layers.baseline);
  L.polyline(ll(r.coords), { color: '#fff', weight: 11, opacity: .95 }).addTo(layers.route);
  const line = L.polyline(ll(r.coords), { color: css('--accent'), weight: 6 }).addTo(layers.route);
  map.fitBounds(line.getBounds(), { paddingTopLeft: innerWidth > 760 ? [460, 40] : [30, 30], paddingBottomRight: innerWidth > 760 ? [40, 40] : [30, innerHeight * .62 + 20], maxZoom: 16 });

  for (const w of r.waits) {
    L.marker([w.coords[1], w.coords[0]], { icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="wait-pin">${ICON.waitPin}</div>` }) })
      .bindTooltip(`Počakaj do ${fmtTime(w.untilMs)}: ${w.closure.name}`).addTo(layers.conflicts);
  }
  const diff = baseline ? Math.round((r.timeS - baseline.timeS) / 60) : 0;
  const arrive = departMs() + r.timeS * 1000;
  let html = '';
  if (r.waits.length) {
    html += `<div class="alert">
      <h2>${ICON.clock}Ob ${at} bo treba počakati</h2>
      <p>Zapelji se do mesta, označenega z uro na zemljevidu, in počakaj. ${opensTxt(r.waits)} Čakanje je že vključeno v čas poti.</p>
      ${showingWait ? '<button class="link" id="hideWait">Nazaj na pot brez čakanja</button>' : ''}</div>`;
  }
  html += `<div class="summary">
    <div class="top"><span class="dur">${fmtDur(r.timeS)}</span><span class="km">${fmtKm(r.lengthKm)}</span></div>
    <div class="tiles"><div class="tile"><span>Odhod</span><b>${fmtTime(departMs())}</b></div><div class="tile"><span>Prihod</span><b>${fmtTime(arrive)}</b></div></div>
    <div class="check">${ICON.ok}Brez zaprtih cest${changed ? ` · brez zapor ${fmtDur(baseline.timeS)}${diff > 0 ? ` (+${diff} min)` : ''}` : ' · zapore te poti ne podaljšajo'}</div>
  </div>`;
  for (const o of passOpen) {
    html += `<div class="info"><span class="ic"></span><span><b>${o.closure.name}</b> se odpre ob ${fmtTime(o.closure.endMs)}. Tam boš ob ~${fmtTime(o.atMs)}, zato je zapora na zemljevidu prikazana kot odprta.</span></div>`;
  }
  html += `<details><summary>Navodila za pot (${r.maneuvers.length})</summary><ol class="steps">${
    r.maneuvers.map((m) => `<li>${m.instruction}${m.length > 0 ? ` <span class="d">· ${m.length < 1 ? Math.round(m.length * 1000) + ' m' : m.length.toFixed(1).replace('.', ',') + ' km'}</span>` : ''}</li>`).join('')
  }</ol></details>`;
  $('result').innerHTML = html;
  if ($('hideWait')) $('hideWait').onclick = () => { state.showWait = false; route(); };
}

// ---------- dogodki ----------

async function loadEvent(id) {
  state.net = null;
  $('result').innerHTML = '<div class="loading"><span class="spinner"></span>Nalagam cestno omrežje …</div>';
  const [gj, raw] = await Promise.all([
    fetch(`events/${id}.geojson`).then((r) => r.json()),
    fetch(`events/${id}.graph.json`).then((r) => r.json()),
  ]);
  state.ev = prepareEvent(gj);
  const m = state.ev.meta;
  $('day').innerHTML = m.days.map((d) => `<option value="${d}">${fmtDay(d)}</option>`).join('');
  const [d, t] = (m.defaultTime || `${m.days[0]}T10:00`).split('T');
  $('day').value = d; $('time').value = t;
  $('source').href = m.source?.startsWith('http') ? m.source : '#';
  map.setView([m.center[1], m.center[0]], m.zoom || 13);
  drawClosures();
  state.net = buildNetwork(raw, state.ev);
  const modes = raw.modes || ['auto', 'bicycle', 'pedestrian'];
  for (const b of $('modes').children) b.hidden = !modes.includes(b.dataset.mode);
  if (!modes.includes(state.mode)) $('modes').querySelector('[data-mode="auto"]').click();
  $('result').innerHTML = '';
  route();
}

async function init() {
  const events = await (await fetch('events/index.json')).json();
  $('event').innerHTML = events.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
  const want = new URLSearchParams(location.search).get('event');
  if (want && events.some((e) => e.id === want)) $('event').value = want;
  $('event').onchange = () => {
    // drug dogodek je lahko v drugem kraju – začni s praznima točkama
    for (const k of ['from', 'to']) { state[k] = null; $(k).value = ''; markers[k].remove(); }
    layers.route.clearLayers(); layers.baseline.clearLayers(); layers.conflicts.clearLayers();
    loadEvent($('event').value);
  };
  $('day').onchange = $('time').onchange = () => { state.showWait = false; drawClosures(); route(); };
  $('modes').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.mode = b.dataset.mode;
    [...$('modes').children].forEach((x) => x.setAttribute('aria-pressed', x === b));
    route();
  };
  $('swap').onclick = () => {
    [state.from, state.to] = [state.to, state.from];
    [$('from').value, $('to').value] = [$('to').value, $('from').value];
    for (const k of ['from', 'to']) state[k] ? markers[k].setLatLng([state[k][1], state[k][0]]).addTo(map) : markers[k].remove();
    route();
  };
  $('locate').onclick = () => navigator.geolocation?.getCurrentPosition(
    (p) => setPlace('from', [p.coords.longitude, p.coords.latitude], null),
    () => alert('Lokacije ni bilo mogoče pridobiti.'));
  setupSearch('from'); setupSearch('to');
  await loadEvent($('event').value);
}

init();
