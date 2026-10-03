import { prepareEvent, isActive } from './routing.js';
import { buildNetwork, route as routeOnNet, laterDeparture } from './graph.js';

const PHOTON = 'https://photon.komoot.io';
const CROSSING_WAIT_MIN = 20; // organizator: »ne več kot 20 minut« na prehod
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const state = { ev: null, net: null, from: null, to: null, mode: 'auto', run: 0 };

// ---------- karta ----------

const map = L.map('map', { zoomControl: true }).setView([46.056, 14.505], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layers = {
  closures: L.layerGroup().addTo(map),
  crossings: L.layerGroup().addTo(map),
  baseline: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  conflicts: L.layerGroup().addTo(map),
};
const pin = (color) => L.divIcon({
  className: '', iconSize: [22, 22], iconAnchor: [11, 11],
  html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
});
const markers = {
  from: L.marker([0, 0], { draggable: true, icon: pin('#12805c') }),
  to: L.marker([0, 0], { draggable: true, icon: pin('#d92d20') }),
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

function drawClosures() {
  const t = departMs();
  layers.closures.clearLayers(); layers.crossings.clearLayers();
  let n = 0;
  // neaktivne spodaj, aktivne zgoraj
  const sorted = [...state.ev.closures].sort((a, b) => isActive(a, t, t + 1) - isActive(b, t, t + 1));
  for (const c of sorted) {
    const on = isActive(c, t, t + 1); n += on;
    L.polyline(c.coords.map(([x, y]) => [y, x]), {
      color: on ? css('--closed') : css('--closed-off'), weight: on ? 6 : 3, opacity: on ? .85 : .55,
      dashArray: on ? null : '4 6',
    }).bindTooltip(`<b>${c.name}</b><br>${c.note || ''}<br>Zaprto ${hhmm(c.start)}–${hhmm(c.end)}`, { sticky: true })
      .addTo(layers.closures);
  }
  for (const c of state.ev.crossings) {
    const on = isActive(c, t, t + 1);
    L.circleMarker([c.coords[1], c.coords[0]], {
      radius: 7, color: '#fff', weight: 2, fillColor: css('--crossing'), fillOpacity: on ? 1 : .45,
    }).bindTooltip(`<b>Prehod</b><br>${c.name}<br>Varovan ${hhmm(c.start)}–${hhmm(c.end)}<br>${c.note || ''}`)
      .addTo(layers.crossings);
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
  const opts = { from: state.from, to: state.to, departMs: departMs(), costing: state.mode, avoidCrossings: $('avoidCrossings').checked };
  $('result').innerHTML = '<div class="card"><span class="spinner"></span>Računam pot …</div>';
  // izračun je sinhron (~50 ms); setTimeout pusti brskalniku, da izriše »računam«
  setTimeout(() => {
    if (run !== state.run) return;
    const baseline = routeOnNet(state.net, state.ev, { ...opts, closures: false });
    let r = routeOnNet(state.net, state.ev, opts), crossingFallback = false;
    if (!r && opts.avoidCrossings) {
      r = routeOnNet(state.net, state.ev, { ...opts, avoidCrossings: false });
      crossingFallback = !!r;
    }
    const later = r ? null : laterDeparture(state.net, state.ev, { ...opts, avoidCrossings: false });
    render({ route: r, baseline, crossingFallback, later });
  }, 10);
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

function render({ route: r, baseline, crossingFallback, later }) {
  layers.route.clearLayers(); layers.baseline.clearLayers(); layers.conflicts.clearLayers();
  const ll = (c) => c.map(([x, y]) => [y, x]);

  if (!r) {
    if (baseline) L.polyline(ll(baseline.coords), { color: css('--muted'), weight: 4, opacity: .6, dashArray: '2 8' }).addTo(layers.baseline);
    const t = departMs(), near = [state.from, state.to].flatMap((p) => closuresNear(p, t));
    const why = near.length
      ? `Izhodišče ali cilj je ob zaprti cesti: ${[...new Map(near.map((c) => [c.name, c])).values()].map((c) => `<b>${c.name}</b> (do ${fmtWhen(c.endMs)})`).join(', ')}.`
      : `Izhodišče ali cilj je ob ${$('time').value} obkrožen z zaporami in tam ni prehoda.`;
    $('result').innerHTML = `<div class="card">
      <span class="badge warn">Ob tej uri poti ni</span>
      <div class="note">${why}
      ${later ? `<div style="margin-top:6px">Prva možnost: odhod ob <b>${fmtTime(later.departMs)}</b> (${fmtDur(later.route.timeS)}, ${fmtKm(later.route.lengthKm)}). <button id="useLater">Uporabi ta čas</button></div>`
        : '<div style="margin-top:6px">Tudi v naslednjih 8 urah poti nisem našel.</div>'}</div></div>`;
    if ($('useLater')) $('useLater').onclick = () => { $('time').value = fmtTime(later.departMs); drawClosures(); route(); };
    return;
  }

  const changed = baseline && (Math.abs(r.timeS - baseline.timeS) > 30 || Math.abs(r.lengthKm - baseline.lengthKm) > .1);
  if (changed) L.polyline(ll(baseline.coords), { color: css('--muted'), weight: 4, opacity: .6, dashArray: '2 8' })
    .bindTooltip('Običajna pot (brez zapor)').addTo(layers.baseline);
  L.polyline(ll(r.coords), { color: '#fff', weight: 9, opacity: .9 }).addTo(layers.route);
  const line = L.polyline(ll(r.coords), { color: css('--accent'), weight: 5 }).addTo(layers.route);
  for (const c of r.usedCrossings) {
    L.circleMarker([c.coords[1], c.coords[0]], { radius: 12, color: css('--warn'), weight: 3, fill: false })
      .bindTooltip(`Prehod: ${c.name}`).addTo(layers.conflicts);
  }
  map.fitBounds(line.getBounds(), { padding: [40, 40], maxZoom: 16 });

  for (const w of r.waits) {
    L.marker([w.coords[1], w.coords[0]], { icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
      html: `<div style="width:26px;height:26px;border-radius:50%;background:${css('--warn')};color:#fff;font-weight:700;font-size:13px;display:grid;place-items:center;border:2px solid #fff">⏱</div>` }) })
      .bindTooltip(`Počakaj do ${fmtTime(w.untilMs)}: ${w.closure.name}`).addTo(layers.conflicts);
  }
  const diff = baseline ? Math.round((r.timeS - baseline.timeS) / 60) : 0;
  const arrive = departMs() + r.timeS * 1000;
  const waitMin = r.usedCrossings.length * CROSSING_WAIT_MIN;
  let html = `<div class="card">`;
  html += waitMin
    ? `<div class="big">${Math.round(r.timeS / 60)}–${fmtDur(r.timeS + waitMin * 60)} <small>· ${fmtKm(r.lengthKm)} · prihod ${fmtTime(arrive)}–${fmtTime(arrive + waitMin * 60000)}</small></div>`
    : `<div class="big">${fmtDur(r.timeS)} <small>· ${fmtKm(r.lengthKm)} · prihod ${fmtTime(arrive)}</small></div>`;
  html += changed
    ? `<div class="cmp">Brez zapor: ${fmtDur(baseline.timeS)}, ${fmtKm(baseline.lengthKm)}${diff > 0 ? ` (zapore dodajo ~${diff} min)` : ''}</div>`
    : `<div class="cmp">Zapore te poti ne podaljšajo.</div>`;
  if (r.waits.length) {
    html += `<div class="note">Hitreje je počakati, da se zapora odpre, kot iti naokoli${r.waits.length > 1 ? ' (večkrat)' : ''}:
      <ul class="list">${r.waits.map((w) => `<li>Počakaj do <b>${fmtTime(w.untilMs)}</b> (~${Math.round(w.seconds / 60)} min)${w.street ? ` – ${w.street}` : ''}; zapora: ${w.closure.name}</li>`).join('')}</ul>
      Čakanje je že vključeno v čas poti. Ura odprtja je ocena organizatorja.</div>`;
  }
  html += r.usedCrossings.length
    ? `<span class="badge ok">✓ Ne vozi po zaprtih cestah</span>`
    : `<span class="badge ok">✓ Pot se izogne vsem zaporam${$('avoidCrossings').checked ? ' in prehodom' : ''}</span>`;

  if (r.usedCrossings.length) {
    const names = r.usedCrossings.map((c) => `<b>${c.name.replace(/^[^:]+:\s*/, '')}</b>`).join(' in ');
    html += `<div class="note">${crossingFallback ? 'Brez prečkanja trase do cilja ob tem času ni poti. ' : ''}
      Pot gre čez traso na varovanem ${r.usedCrossings.length > 1 ? 'prehodih' : 'prehodu'} (${names}).
      Redarji spuščajo promet čez med skupinami tekačev – lahko čakaš do ${CROSSING_WAIT_MIN} min${r.usedCrossings.length > 1 ? ' na vsakem' : ''}.
      <ul class="list">${r.usedCrossings.map((c) => `<li>${c.name} – varovan ${hhmm(c.start)}–${hhmm(c.end)}</li>`).join('')}</ul>
      ${crossingFallback ? '' : '<div style="margin-top:6px"><button id="tryAvoid">Poišči pot brez prehoda</button></div>'}</div>`;
  }
  if (r.snapGapM > 80) html += `<div class="note">Izhodišče ali cilj je ${Math.round(r.snapGapM)} m od najbližje ceste, primerne za izbrani prevoz – zadnji del poti ni v izračunu.</div>`;
  html += `<details><summary>Navodila (${r.maneuvers.length})</summary><ol class="steps">${
    r.maneuvers.map((m) => `<li>${m.instruction}${m.length > 0 ? ` <span style="color:var(--muted)">· ${m.length < 1 ? Math.round(m.length * 1000) + ' m' : m.length.toFixed(1).replace('.', ',') + ' km'}</span>` : ''}</li>`).join('')
  }</ol></details>`;
  html += `</div>`;
  $('result').innerHTML = html;
  if ($('tryAvoid')) $('tryAvoid').onclick = () => { $('avoidCrossings').checked = true; route(); };
}

// ---------- dogodki ----------

async function loadEvent(id) {
  state.net = null;
  $('result').innerHTML = '<div class="card"><span class="spinner"></span>Nalagam cestno omrežje …</div>';
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
  $('avoidCrossings').closest('label').hidden = !state.ev.crossings.length;
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
  $('day').onchange = $('time').onchange = () => { drawClosures(); route(); };
  $('avoidCrossings').onchange = () => route();
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
