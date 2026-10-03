import { prepareEvent, planRoute, findLaterDeparture, isActive } from './routing.js';

const PHOTON = 'https://photon.komoot.io';
const CROSSING_WAIT_MIN = 20; // organizator: »ne več kot 20 minut« na prehod
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const state = { ev: null, from: null, to: null, mode: 'auto', run: 0, abort: null };

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

async function route() {
  if (!state.from || !state.to) return;
  const run = ++state.run;
  state.abort?.abort(); state.abort = new AbortController();
  const opts = {
    from: state.from, to: state.to, departMs: departMs(), costing: state.mode,
    avoidCrossings: $('avoidCrossings').checked, signal: state.abort.signal,
    onProgress: (it) => { if (run === state.run) $('result').innerHTML = `<div class="card"><span class="spinner"></span>${it ? `Iščem obvoz … (${it}. poskus)` : 'Računam pot …'}</div>`; },
  };
  let r;
  try {
    r = await planRoute(state.ev, opts);
    // Brez prehodov ne gre → pokaži pot čez prehod (in to povej).
    if (opts.avoidCrossings && r.status !== 'ok') {
      const viaCrossing = await planRoute(state.ev, { ...opts, avoidCrossings: false,
        onProgress: () => { if (run === state.run) $('result').innerHTML = '<div class="card"><span class="spinner"></span>Brez prehoda ne gre – računam pot čez prehod …</div>'; } });
      if (viaCrossing.status === 'ok') r = { ...viaCrossing, crossingFallback: true };
    }
  }
  catch (e) {
    if (e.name === 'AbortError' || run !== state.run) return;
    $('result').innerHTML = `<div class="card"><div class="note">Poti ni bilo mogoče izračunati: ${e.message}</div></div>`;
    return;
  }
  if (run !== state.run) return;
  render(r);
  if (r.status !== 'ok') {
    const later = await findLaterDeparture(state.ev, { ...opts, avoidCrossings: false }, r).catch(() => null);
    if (run !== state.run) return;
    const box = $('laterBox');
    if (!box) return;
    if (later) {
      box.innerHTML = `Brez prečkanja zapor lahko greš ob <b>${fmtTime(later.departMs)}</b> (${fmtDur(later.result.route.timeS)}). <button id="useLater">Uporabi ta čas</button>`;
      $('useLater').onclick = () => { $('time').value = fmtTime(later.departMs); drawClosures(); route(); };
    } else box.textContent = 'Kasnejšega odhoda brez zapor na tej poti nisem našel.';
  }
}

function render(r) {
  layers.route.clearLayers(); layers.baseline.clearLayers(); layers.conflicts.clearLayers();
  const ll = (c) => c.map(([x, y]) => [y, x]);
  const changed = Math.abs(r.route.timeS - r.baseline.timeS) > 30 || Math.abs(r.route.lengthKm - r.baseline.lengthKm) > .1;
  if (changed) L.polyline(ll(r.baseline.coords), { color: css('--muted'), weight: 4, opacity: .6, dashArray: '2 8' })
    .bindTooltip('Običajna pot (brez zapor)').addTo(layers.baseline);
  L.polyline(ll(r.route.coords), { color: '#fff', weight: 9, opacity: .9 }).addTo(layers.route);
  const line = L.polyline(ll(r.route.coords), { color: css('--accent'), weight: 5 }).addTo(layers.route);
  for (const c of r.conflicts) {
    L.marker([c.coords[1], c.coords[0]], { icon: L.divIcon({ className: '', iconSize: [24, 24], iconAnchor: [12, 12],
      html: `<div style="width:24px;height:24px;border-radius:50%;background:${css('--closed')};color:#fff;font-weight:800;display:grid;place-items:center;border:2px solid #fff">!</div>` }) })
      .bindTooltip(`Pot tu prečka zaporo: ${c.closure.name} (${hhmm(c.closure.start)}–${hhmm(c.closure.end)})`).addTo(layers.conflicts);
  }
  map.fitBounds(line.getBounds(), { padding: [40, 40], maxZoom: 16 });

  const diff = Math.round((r.route.timeS - r.baseline.timeS) / 60);
  const arrive = departMs() + r.route.timeS * 1000;
  const waitMin = r.usedCrossings.length * CROSSING_WAIT_MIN;
  const km = `${r.route.lengthKm.toFixed(1).replace('.', ',')} km`;
  let html = `<div class="card">`;
  html += waitMin
    ? `<div class="big">${Math.round(r.route.timeS / 60)}–${fmtDur(r.route.timeS + waitMin * 60)} <small>· ${km} · prihod ${fmtTime(arrive)}–${fmtTime(arrive + waitMin * 60000)}</small></div>`
    : `<div class="big">${fmtDur(r.route.timeS)} <small>· ${km} · prihod ${fmtTime(arrive)}</small></div>`;
  html += changed
    ? `<div class="cmp">Brez zapor: ${fmtDur(r.baseline.timeS)}, ${r.baseline.lengthKm.toFixed(1).replace('.', ',')} km${diff > 0 ? ` (zapore dodajo ~${diff} min)` : ''}</div>`
    : `<div class="cmp">Zapore te poti ne podaljšajo.</div>`;

  if (r.status === 'ok') {
    html += r.usedCrossings.length
      ? `<span class="badge ok">✓ Ne vozi po zaprtih cestah</span>`
      : `<span class="badge ok">✓ Pot se izogne vsem zaporam${$('avoidCrossings').checked ? ' in prehodom' : ''}</span>`;
  } else {
    html += `<span class="badge warn">Pot ne gre brez prečkanja zapore</span>
      <div class="note">${r.status === 'no-route'
        ? 'Iz izhodišča ali do cilja ob tem času ni poti mimo zapor (morda si znotraj zaprte zanke).'
        : 'Obvoza nisem našel v okviru omejitev javnega usmerjevalnika.'}
        Prikazana pot prečka zaporo na označenih mestih (!).
        <div id="laterBox" style="margin-top:6px"><span class="spinner"></span>Iščem kasnejši odhod …</div></div>`;
  }
  if (r.usedCrossings.length) {
    const names = r.usedCrossings.map((c) => `<b>${c.name.replace(/^[^:]+:\s*/, '')}</b>`).join(' in ');
    html += `<div class="note">${r.crossingFallback ? 'Brez prečkanja trase do cilja ob tem času ni poti. ' : ''}
      Pot gre čez traso na varovanem ${r.usedCrossings.length > 1 ? 'prehodih' : 'prehodu'} (${names}).
      Redarji spuščajo promet čez med skupinami tekačev – lahko čakaš do ${CROSSING_WAIT_MIN} min${r.usedCrossings.length > 1 ? ' na vsakem' : ''}.
      <ul class="list">${r.usedCrossings.map((c) => `<li>${c.name} – varovan ${hhmm(c.start)}–${hhmm(c.end)}</li>`).join('')}</ul>
      ${r.crossingFallback ? '' : '<div style="margin-top:6px"><button id="tryAvoid">Poišči pot brez prehoda</button></div>'}</div>`;
  }
  if (r.atEndpoint) html += `<div class="note">Izhodišče ali cilj je tik ob zaprti cesti – zadnjih nekaj metrov morda ne bo prevoznih.</div>`;
  html += `<details><summary>Navodila (${r.route.maneuvers.length})</summary><ol class="steps">${
    r.route.maneuvers.map((m) => `<li>${m.instruction}${m.length > 0 ? ` <span style="color:var(--muted)">· ${m.length < 1 ? Math.round(m.length * 1000) + ' m' : m.length.toFixed(1).replace('.', ',') + ' km'}</span>` : ''}</li>`).join('')
  }</ol></details>`;
  html += `</div>`;
  $('result').innerHTML = html;
  if ($('tryAvoid')) $('tryAvoid').onclick = () => { $('avoidCrossings').checked = true; route(); };
}

// ---------- dogodki ----------

async function loadEvent(id) {
  const gj = await (await fetch(`events/${id}.geojson`)).json();
  state.ev = prepareEvent(gj);
  const m = state.ev.meta;
  $('day').innerHTML = m.days.map((d) => `<option value="${d}">${fmtDay(d)}</option>`).join('');
  const [d, t] = (m.defaultTime || `${m.days[0]}T10:00`).split('T');
  $('day').value = d; $('time').value = t;
  $('source').href = m.source?.startsWith('http') ? m.source : '#';
  map.setView([m.center[1], m.center[0]], m.zoom || 13);
  drawClosures();
  route();
}

async function init() {
  const events = await (await fetch('events/index.json')).json();
  $('event').innerHTML = events.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
  const want = new URLSearchParams(location.search).get('event');
  if (want && events.some((e) => e.id === want)) $('event').value = want;
  $('event').onchange = () => loadEvent($('event').value);
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
