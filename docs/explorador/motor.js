/* La planta de ContApp — motor del explorador.
   Lee window.CONTAPP_DATA = { estaciones: {}, retos: {}, tour: [] }.
   Dibuja la escena SVG (posiciones e IDs viven AQUÍ), maneja panel, vistas, tour, retos y cinta. */
(function () {
  'use strict';

  var DATA = window.CONTAPP_DATA || {};
  var EST = DATA.estaciones || {};
  var RETOS = DATA.retos || {};
  var TOUR = Array.isArray(DATA.tour) ? DATA.tour.slice() : [];

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var FULL = { x: 0, y: 0, w: 1000, h: 860 };
  var RATIO = FULL.w / FULL.h;
  var TIPOS_RETO = { opcion: 'Elige la respuesta', clasificar: 'Clasifica', numero: 'Calcula', encontrar: 'Encuentra' };

  /* ---------------------------------------------------------------- utilidades */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* Formato mínimo: **negrita** y `código`. Todo se escapa antes. */
  function fmt(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; }
    return null;
  }
  function anunciar(t) {
    var a = $('#anuncio'); if (!a) return;
    a.textContent = ''; setTimeout(function () { a.textContent = t; }, 30);
  }
  function isWide() { return window.matchMedia('(min-width: 900px)').matches; }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  /* ---------------------------------------------------------------- escena: definición */
  /* Cinta: fila 1 (y=450) izquierda→derecha, curva, fila 2 (y=700) derecha→izquierda. */
  var BELT_D = 'M 40 450 H 850 A 125 125 0 0 1 850 700 H 40';
  var R1 = 450, R2 = 700;

  /* box = área clicable + anillo + encuadre de cámara. */
  var SCENE = [
    { id: 'sunat-entrada', tipo: 'estacion', label: 'SUNAT', icono: '🏛️', box: [25, 305, 160, 200], draw: function () { return dSunat(105, R1, 'propuesta'); }, labelY: 495 },
    { id: 'descarga', tipo: 'estacion', label: 'Descarga', icono: '📥', box: [250, 340, 160, 165], draw: function () { return dDescarga(330, 350); }, labelY: 495 },
    { id: 'motor-reglas', tipo: 'estacion', label: 'Motor de reglas', icono: '⚙️', box: [478, 340, 164, 165], draw: function () { return dMotor(560, 350); }, labelY: 495 },
    { id: 'lupa', tipo: 'estacion', label: 'Lupa', icono: '🔍', box: [705, 340, 160, 165], draw: function () { return dLupa(785, 350); }, labelY: 495 },
    { id: 'clasificacion', tipo: 'estacion', label: 'Clasificación', icono: '🗂️', box: [612, 590, 246, 262], draw: function () { return dClasif(735, 600); }, labelY: 840 },
    { id: 'prevalidacion', tipo: 'estacion', label: 'Prevalidación', icono: '✅', box: [390, 590, 160, 165], draw: function () { return dPreval(470, 600); }, labelY: 745 },
    { id: 'zip', tipo: 'estacion', label: 'TXT / ZIP', icono: '📦', box: [205, 590, 160, 165], draw: function () { return dZip(285, 600); }, labelY: 745 },
    { id: 'sunat-salida', tipo: 'estacion', label: 'SUNAT', icono: '📤', box: [25, 555, 160, 200], draw: function () { return dSunat(105, R2, 'reemplazo'); }, labelY: 745 },

    { id: 'edificio-estudios', tipo: 'zona', label: 'Edificio de estudios', icono: '🏢', box: [12, 12, 196, 290], draw: dEdificio, labelY: 292 },
    { id: 'recepcion', tipo: 'zona', label: 'Recepción', icono: '🛎️', box: [214, 132, 184, 170], draw: dRecepcion, labelY: 292 },
    { id: 'boveda', tipo: 'zona', label: 'Bóveda', icono: '🔐', box: [414, 100, 172, 202], draw: dBoveda, labelY: 292 },
    { id: 'torre-buzones', tipo: 'zona', label: 'Torre de buzones', icono: '📬', box: [592, 12, 166, 290], draw: dTorre, labelY: 292 },
    { id: 'balanza-prorrata', tipo: 'zona', label: 'Balanza de prorrata', icono: '⚖️', box: [768, 122, 214, 180], draw: dBalanza, labelY: 292 }
  ];
  var BY_ID = {};
  SCENE.forEach(function (s) { BY_ID[s.id] = s; });

  /* Hitos a lo largo de la cinta (distancia recorrida) para cambiar el estado de las tarjetas. */
  var L_ROW = 810, L_ARC = Math.PI * 125;
  var S_MOTOR = 560 - 40;
  var S_CLASIF = L_ROW + L_ARC + (850 - 735);
  var S_ZIP = L_ROW + L_ARC + (850 - 285);

  /* ---------------------------------------------------------------- escena: dibujos */
  function hood(cx, top, w) {
    w = w || 150;
    return '<rect class="s-mach" x="' + (cx - w / 2) + '" y="' + top + '" width="' + w + '" height="100" rx="14"/>' +
      '<rect class="s-mach-2" x="' + (cx - w / 2 + 14) + '" y="' + (top + 76) + '" width="' + (w - 28) + '" height="22" rx="5"/>';
  }
  function dSunat(cx, baseY, sub) {
    var top = baseY - 95, cols = '';
    for (var i = 0; i < 4; i++) cols += '<rect class="s-sunat-ink" x="' + (cx - 51 + i * 30) + '" y="' + (top + 8) + '" width="12" height="70" rx="2" opacity=".85"/>';
    return '<rect class="s-sunat" x="' + (cx - 70) + '" y="' + top + '" width="140" height="88" rx="4"/>' + cols +
      '<polygon class="s-sunat" points="' + (cx - 82) + ',' + top + ' ' + cx + ',' + (top - 40) + ' ' + (cx + 82) + ',' + top + '"/>' +
      '<text class="s-tiny" x="' + cx + '" y="' + (top - 9) + '">' + esc(sub) + '</text>';
  }
  function dDescarga(cx, t) {
    return hood(cx, t) +
      '<path class="s-fill-stroke" d="M ' + (cx - 12) + ' ' + (t + 12) + ' h 24 v 24 h 15 l -27 28 l -27 -28 h 15 z"/>' +
      '<text class="s-tiny" x="' + cx + '" y="' + (t + 76) + '" dy="-2">API SIRE</text>';
  }
  function gear(cx, cy, r, teeth, dir) {
    var c = 2 * Math.PI * r, d = (c / (teeth * 2)).toFixed(2);
    return '<g class="gear" data-cx="' + cx + '" data-cy="' + cy + '" data-dir="' + dir + '">' +
      '<circle class="s-gear" cx="' + cx + '" cy="' + cy + '" r="' + r + '" stroke-width="10" stroke-dasharray="' + d + ' ' + d + '"/>' +
      '<circle class="s-gear" cx="' + cx + '" cy="' + cy + '" r="' + (r - 5) + '" stroke-width="2.5"/>' +
      '<circle class="s-surface" cx="' + cx + '" cy="' + cy + '" r="' + Math.round(r * 0.35) + '"/></g>';
  }
  function dMotor(cx, t) {
    return hood(cx, t, 154) + gear(cx - 26, t + 38, 24, 10, 1) + gear(cx + 30, t + 46, 17, 8, -1) +
      '<circle class="s-gold" cx="' + (cx + 52) + '" cy="' + (t + 14) + '" r="6"/>';
  }
  function dLupa(cx, t) {
    return hood(cx, t) +
      '<rect class="s-surface" x="' + (cx - 46) + '" y="' + (t + 10) + '" width="46" height="58" rx="4"/>' +
      '<path class="s-stroke" stroke-width="2" d="M ' + (cx - 38) + ' ' + (t + 24) + ' h 30 M ' + (cx - 38) + ' ' + (t + 34) + ' h 30 M ' + (cx - 38) + ' ' + (t + 44) + ' h 20"/>' +
      '<line class="s-stroke" stroke-width="10" x1="' + (cx + 24) + '" y1="' + (t + 58) + '" x2="' + (cx + 44) + '" y2="' + (t + 76) + '"/>' +
      '<circle class="s-lens" cx="' + (cx + 10) + '" cy="' + (t + 42) + '" r="21"/>';
  }
  function dClasif(cx, t) {
    var bins = [['dg', 'DG', cx - 88], ['dgng', 'DGNG', cx], ['dng', 'DNG', cx + 88]], out = hood(cx, t, 230);
    bins.forEach(function (b) {
      out += '<circle class="s-' + b[0] + '" cx="' + b[2] + '" cy="' + (t + 38) + '" r="14"/>';
      out += '<path class="s-stroke" stroke-width="3" d="M ' + (b[2] - 18) + ' ' + (R2 + 16) + ' l 8 14 h 20 l 8 -14"/>';
      out += '<rect class="s-bin-' + b[0] + '" x="' + (b[2] - 38) + '" y="' + (R2 + 30) + '" width="76" height="62" rx="9"/>';
      out += '<text class="s-tiny" x="' + b[2] + '" y="' + (R2 + 67) + '">' + b[1] + '</text>';
    });
    return out;
  }
  function dPreval(cx, t) {
    return hood(cx, t) +
      '<circle class="s-okc" cx="' + cx + '" cy="' + (t + 38) + '" r="26"/>' +
      '<path class="s-okp" d="M ' + (cx - 12) + ' ' + (t + 39) + ' l 8 9 l 17 -19"/>';
  }
  function dZip(cx, t) {
    return hood(cx, t) +
      '<polygon class="s-mach-2" points="' + (cx - 34) + ',' + (t + 24) + ' ' + (cx - 20) + ',' + (t + 10) + ' ' + (cx + 34) + ',' + (t + 10) + ' ' + (cx + 34) + ',' + (t + 24) + '"/>' +
      '<rect class="s-gold" x="' + (cx - 34) + '" y="' + (t + 24) + '" width="68" height="46" rx="4" stroke="var(--machine-stroke)" stroke-width="2.5"/>' +
      '<path class="s-stroke" stroke-width="3" stroke-dasharray="4 4" d="M ' + cx + ' ' + (t + 26) + ' v 42"/>';
  }
  function dEdificio() {
    var cols = ['var(--dg)', 'var(--dgng)', 'var(--dng)', 'var(--accent)'], out = '';
    out += '<rect class="s-mach-2" x="38" y="20" width="144" height="18" rx="5"/>';
    out += '<rect class="s-mach" x="46" y="36" width="128" height="232" rx="6"/>';
    for (var i = 0; i < 4; i++) {
      var y = 46 + i * 50;
      out += '<rect class="s-surface" x="56" y="' + y + '" width="108" height="40" rx="6"/>';
      out += '<rect x="56" y="' + y + '" width="9" height="40" rx="3" style="fill:' + cols[i] + '"/>';
      out += '<text class="s-tiny" x="114" y="' + (y + 25) + '">Estudio ' + 'ABCD'.charAt(3 - i) + '</text>';
    }
    out += '<rect class="s-mach-2" x="94" y="248" width="32" height="20" rx="3"/>';
    return out;
  }
  function dRecepcion() {
    return '<rect class="s-surface" x="250" y="142" width="110" height="30" rx="6"/>' +
      '<text class="s-tiny" x="305" y="162">Roles</text>' +
      '<circle class="s-person" cx="268" cy="196" r="13"/><rect class="s-person" x="252" y="210" width="32" height="20" rx="9"/>' +
      '<circle class="s-person" cx="342" cy="196" r="13" opacity=".7"/><rect class="s-person" x="326" y="210" width="32" height="20" rx="9" opacity=".7"/>' +
      '<rect class="s-mach" x="222" y="220" width="166" height="48" rx="8"/>' +
      '<circle class="s-gold" cx="305" cy="217" r="7"/>' +
      '<text class="s-tiny" x="305" y="250">Asignación</text>';
  }
  function dBoveda() {
    var sp = '';
    for (var a = 0; a < 3; a++) {
      var ang = a * Math.PI / 3, dx = Math.cos(ang) * 36, dy = Math.sin(ang) * 36;
      sp += '<line class="s-stroke" stroke-width="5" x1="' + (500 - dx).toFixed(1) + '" y1="' + (187 - dy).toFixed(1) + '" x2="' + (500 + dx).toFixed(1) + '" y2="' + (187 + dy).toFixed(1) + '"/>';
    }
    return '<rect class="s-mach-2" x="425" y="110" width="150" height="152" rx="16"/>' +
      '<rect class="s-mach" x="436" y="258" width="22" height="10" rx="2"/><rect class="s-mach" x="542" y="258" width="22" height="10" rx="2"/>' +
      '<circle class="s-surface" cx="500" cy="187" r="54" stroke-width="4"/>' +
      '<circle class="s-stroke" cx="500" cy="187" r="40"/>' + sp +
      '<circle class="s-gold" cx="500" cy="187" r="9"/>';
  }
  function dTorre() {
    var out = '<line class="s-stroke" x1="675" y1="16" x2="675" y2="44"/><circle class="s-sunat-ink" cx="675" cy="16" r="5"/>' +
      '<rect class="s-mach" x="620" y="42" width="110" height="226" rx="10"/>';
    var flags = { '0-2': 1, '2-0': 1, '3-1': 1 };
    for (var r = 0; r < 5; r++) for (var c = 0; c < 3; c++) {
      var x = 632 + c * 32, y = 56 + r * 40;
      out += '<rect class="s-surface" x="' + x + '" y="' + y + '" width="24" height="28" rx="4"/>';
      out += '<line class="s-stroke" stroke-width="2" x1="' + (x + 5) + '" y1="' + (y + 9) + '" x2="' + (x + 19) + '" y2="' + (y + 9) + '"/>';
      if (flags[r + '-' + c]) out += '<rect class="s-flag" x="' + (x + 19) + '" y="' + (y - 4) + '" width="8" height="11" rx="1.5"/>';
    }
    return out;
  }
  function dBalanza() {
    return '<text class="s-label" x="873" y="150">%</text>' +
      '<rect class="s-fill-stroke" x="868" y="160" width="10" height="88" rx="3"/>' +
      '<rect class="s-mach" x="838" y="246" width="70" height="20" rx="6"/>' +
      '<line class="s-stroke" stroke-width="6" x1="800" y1="172" x2="946" y2="164"/>' +
      '<circle class="s-gold" cx="873" cy="168" r="8"/>' +
      '<path class="s-stroke" stroke-width="2" d="M 803 172 L 783 210 M 803 172 L 823 210 M 943 164 L 923 202 M 943 164 L 963 202"/>' +
      '<path class="s-surface" d="M 776 210 Q 803 236 830 210 Z"/>' +
      '<path class="s-surface" d="M 916 202 Q 943 228 970 202 Z"/>' +
      '<text class="s-tiny" x="803" y="252">Gravadas</text>' +
      '<text class="s-tiny" x="943" y="244">Total</text>';
  }

  /* ---------------------------------------------------------------- escena: construcción */
  var svg = $('#scene');
  var cards = [];
  var gears = [];
  var beltDash = null;

  function info(id) {
    var s = BY_ID[id] || {}, d = EST[id] || {};
    var has = !!EST[id];
    return {
      id: id,
      tipo: s.tipo || d.tipo || 'estacion',
      titulo: d.titulo || s.label || id,
      icono: d.icono || s.icono || '•',
      pendiente: !has || !!d.pendiente,
      data: d
    };
  }
  function retosDe(id) {
    return Object.keys(RETOS).filter(function (k) { return RETOS[k] && RETOS[k].estacion === id; });
  }

  function buildScene() {
    var out = '<rect class="s-ground" x="0" y="0" width="1000" height="860"/>' +
      '<rect class="s-ground-2" x="0" y="318" width="1000" height="542"/>' +
      '<path class="s-path" d="M 110 302 V 318 M 305 302 V 318 M 500 302 V 318 M 675 302 V 318 M 875 302 V 318"/>';
    var zonas = '', estaciones = '';
    SCENE.forEach(function (s) {
      var i = info(s.id), b = s.box;
      var cx = b[0] + b[2] / 2;
      var g = '<g class="hit" id="hit-' + s.id + '" data-id="' + s.id + '" role="button" tabindex="0" aria-label="' +
        esc(i.titulo + (s.tipo === 'zona' ? ' (zona)' : ' (estación)') + (i.pendiente ? ', contenido en preparación' : '')) + '">' +
        '<rect class="hit-area" x="' + b[0] + '" y="' + b[1] + '" width="' + b[2] + '" height="' + b[3] + '" rx="16"/>' +
        s.draw() +
        '<text class="s-label" x="' + cx + '" y="' + s.labelY + '">' + esc(s.label) + '</text>' +
        (i.pendiente ? '<circle class="pend" cx="' + (b[0] + b[2] - 12) + '" cy="' + (b[1] + 12) + '" r="7"><title>Contenido en preparación</title></circle>' : '') +
        '<rect class="ring" x="' + b[0] + '" y="' + b[1] + '" width="' + b[2] + '" height="' + b[3] + '" rx="16"/>' +
        '</g>';
      if (s.tipo === 'zona') zonas += g; else estaciones += g;
    });
    out += '<g class="zones-layer">' + zonas + '</g><g class="stations-layer">' + estaciones + '</g>';
    out += '<g class="belt-layer" pointer-events="none" aria-hidden="true">' +
      '<path id="belt-path" class="s-belt" d="' + BELT_D + '"/>' +
      '<path class="s-belt-top" d="' + BELT_D + '"/>' +
      '<path id="belt-dash" class="s-belt-dash" d="' + BELT_D + '"/></g>';
    out += '<g class="cards-layer" id="cards-layer" pointer-events="none" aria-hidden="true"></g>';
    svg.innerHTML = out;

    beltDash = $('#belt-dash');
    gears = $$('.gear', svg).map(function (g) {
      return { el: g, cx: +g.getAttribute('data-cx'), cy: +g.getAttribute('data-cy'), dir: +g.getAttribute('data-dir') };
    });

    var layer = $('#cards-layer');
    var clases = ['dg', 'dng', 'dg', 'dgng', 'dng', 'dg', 'dng', 'dg', 'dng', 'dg'];
    var flagged = { 1: 1, 3: 1, 6: 1 };
    var path = $('#belt-path');
    var L = path.getTotalLength();
    var html = '';
    clases.forEach(function (c, k) {
      html += '<g class="card">' +
        '<rect class="card-body" x="-13" y="-34" width="26" height="32" rx="3"/>' +
        '<rect class="card-band raw" x="-13" y="-34" width="26" height="8" rx="3"/>' +
        '<path class="card-line" d="M -8 -20 H 8 M -8 -14 H 8 M -8 -8 H 3"/>' +
        (flagged[k] ? '<circle class="card-flag" cx="11" cy="-33" r="5"/><circle class="card-ok" cx="11" cy="-33" r="5" opacity="0"/>' : '') +
        '</g>';
    });
    layer.innerHTML = html;
    cards = $$('.card', layer).map(function (el, k) {
      return {
        el: el, cls: clases[k], off: (L / clases.length) * k,
        band: $('.card-band', el), flag: $('.card-flag', el), ok: $('.card-ok', el), state: ''
      };
    });
    belt.path = path; belt.L = L;
  }

  /* ---------------------------------------------------------------- cinta animada */
  var belt = { running: !REDUCED, t: 0, last: 0, speed: 55, path: null, L: 1 };

  function setCards() {
    var L = belt.L;
    cards.forEach(function (c) {
      var s = (c.off + belt.t * belt.speed) % L;
      var p = belt.path.getPointAtLength(s);
      var st = s < S_MOTOR ? 'raw' : (s < S_CLASIF ? 'fixed' : c.cls);
      var zipped = s >= S_ZIP;
      c.el.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')' + (zipped ? ' scale(0.78)' : ''));
      if (c.state !== st) {
        c.band.setAttribute('class', 'card-band ' + st);
        if (c.flag) { c.flag.setAttribute('opacity', st === 'raw' ? '1' : '0'); c.ok.setAttribute('opacity', st === 'raw' ? '0' : '1'); }
        c.state = st;
      }
    });
    if (beltDash) beltDash.style.strokeDashoffset = String(-(belt.t * belt.speed) % 24);
    gears.forEach(function (g) {
      g.el.setAttribute('transform', 'rotate(' + ((belt.t * 40 * g.dir) % 360).toFixed(1) + ' ' + g.cx + ' ' + g.cy + ')');
    });
  }
  function loop(ts) {
    if (belt.running) {
      if (belt.last) belt.t += Math.min(0.1, (ts - belt.last) / 1000);
      belt.last = ts;
      setCards();
      requestAnimationFrame(loop);
    } else {
      belt.last = 0;
    }
  }
  function setBelt(run) {
    belt.running = run;
    var b = $('#btn-cinta');
    b.setAttribute('aria-pressed', run ? 'false' : 'true');
    b.setAttribute('aria-label', run ? 'Pausar cinta' : 'Reanudar cinta');
    b.title = run ? 'Pausar cinta' : 'Reanudar cinta';
    b.firstElementChild.textContent = run ? '⏸' : '▶';
    if (run) { belt.last = 0; requestAnimationFrame(loop); }
  }

  /* ---------------------------------------------------------------- cámara (viewBox) */
  var vb = { x: 0, y: 0, w: FULL.w, h: FULL.h };
  var camAnim = 0, camSeq = 0;
  function applyVB() {
    svg.setAttribute('viewBox', vb.x.toFixed(1) + ' ' + vb.y.toFixed(1) + ' ' + vb.w.toFixed(1) + ' ' + vb.h.toFixed(1));
    svg.classList.toggle('zoomed', vb.w < FULL.w - 1);
  }
  function clampVB(v) {
    v.w = Math.max(300, Math.min(FULL.w, v.w)); v.h = v.w / RATIO;
    v.x = Math.max(0, Math.min(FULL.w - v.w, v.x));
    v.y = Math.max(0, Math.min(FULL.h - v.h, v.y));
    return v;
  }
  function camTo(target, ms) {
    target = clampVB(target);
    cancelAnimationFrame(camAnim);
    if (REDUCED || !ms) { camSeq++; vb = target; applyVB(); return; }
    var from = { x: vb.x, y: vb.y, w: vb.w, h: vb.h }, t0 = now();
    function step() {
      var k = Math.min(1, (now() - t0) / ms), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      vb = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: 0 };
      vb.h = vb.w / RATIO; applyVB();
      if (k < 1) camAnim = requestAnimationFrame(step);
    }
    camAnim = requestAnimationFrame(step);
    /* respaldo: si rAF está pausado (pestaña oculta), llegar igual al destino */
    var seq = ++camSeq;
    setTimeout(function () { if (seq === camSeq && !pan) { cancelAnimationFrame(camAnim); vb = target; applyVB(); } }, ms + 120);
  }
  function camFit(id, ms) {
    var s = BY_ID[id]; if (!s) return camTo({ x: 0, y: 0, w: FULL.w }, ms);
    var b = s.box, pad = 50;
    var w = Math.max(b[2] + pad * 2, (b[3] + pad * 2) * RATIO, 420);
    var h = w / RATIO;
    camTo({ x: b[0] + b[2] / 2 - w / 2, y: b[1] + b[3] / 2 - h / 2, w: w }, ms);
  }
  function camZoom(f) {
    var cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2, w = vb.w * f, h = w / RATIO;
    camTo({ x: cx - w / 2, y: cy - h / 2, w: w }, 250);
  }

  /* arrastre para mover la cámara cuando hay zoom */
  var pan = null, suppressClick = false;
  function initPan() {
    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || vb.w >= FULL.w - 1) return;
      pan = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, id: e.pointerId, moving: false };
    });
    svg.addEventListener('pointermove', function (e) {
      if (!pan || e.pointerId !== pan.id) return;
      var dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (!pan.moving && Math.abs(dx) + Math.abs(dy) > 6) {
        pan.moving = true; svg.classList.add('panning');
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* sin captura */ }
      }
      if (pan.moving) {
        var k = vb.w / svg.getBoundingClientRect().width;
        cancelAnimationFrame(camAnim); camSeq++;
        vb = clampVB({ x: pan.vx - dx * k, y: pan.vy - dy * k, w: vb.w }); applyVB();
      }
    });
    function end(e) {
      if (!pan || (e && e.pointerId !== pan.id)) return;
      if (pan.moving) { suppressClick = true; setTimeout(function () { suppressClick = false; }, 0); }
      svg.classList.remove('panning'); pan = null;
    }
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  /* ---------------------------------------------------------------- estado general */
  var state = { vista: store('planta-vista') === 'tecnica' ? 'tecnica' : 'contador', sel: null, opener: null };

  function setVista(v) {
    state.vista = v; store('planta-vista', v);
    $$('.seg-btn').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-vista') === v ? 'true' : 'false'); });
    if (state.sel) renderPanel(state.sel); else renderPanelVacio();
  }

  function markSelected(id) {
    $$('.hit', svg).forEach(function (g) { g.classList.toggle('is-selected', g.getAttribute('data-id') === id); });
    $$('.chip').forEach(function (c) { c.setAttribute('aria-current', c.getAttribute('data-id') === id ? 'true' : 'false'); });
  }

  /* ---------------------------------------------------------------- panel */
  var panel = $('#panel'), panelInner = $('#panel-inner');

  function openPanel(id, opts) {
    opts = opts || {};
    if (!BY_ID[id]) return;
    state.sel = id;
    if (!opts.keepOpener) state.opener = document.activeElement;
    markSelected(id);
    renderPanel(id);
    if (!isWide()) {
      panel.classList.add('open'); document.body.classList.add('sheet-open');
      if (!opts.fromTour) { var h = $('#panel-title'); if (h) h.focus(); }
    }
    panelInner.scrollTop = 0; panel.scrollTop = 0;
    anunciar('Detalle: ' + info(id).titulo);
  }
  function closePanel() {
    var was = state.sel;
    state.sel = null; markSelected(null);
    panel.classList.remove('open'); document.body.classList.remove('sheet-open');
    renderPanelVacio();
    if (was && state.opener && document.body.contains(state.opener)) { try { state.opener.focus(); } catch (e) { /* nada */ } }
  }

  function sec(titulo, cuerpo) { return cuerpo ? '<section class="sec"><h3>' + esc(titulo) + '</h3>' + cuerpo + '</section>' : ''; }
  function pendBox(t, d) { return '<div class="pending-box" role="note"><b>' + esc(t) + '</b>' + esc(d) + '</div>'; }
  function list(arr, f) { return (arr && arr.length) ? '<ul>' + arr.map(function (x) { return '<li>' + (f ? f(x) : fmt(x)) + '</li>'; }).join('') + '</ul>' : ''; }
  function kv(arr, k1, k2, k3) {
    if (!arr || !arr.length) return '';
    return '<ul class="kv">' + arr.map(function (o) {
      return '<li><b>' + fmt(o[k1]) + '</b>' + fmt(o[k2] || '') + (k3 && o[k3] ? ' <span class="empty">(' + fmt(o[k3]) + ')</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function renderContador(c) {
    var h = '';
    h += sec('Qué hace', c.queHace ? '<p>' + fmt(c.queHace) + '</p>' : '');
    h += sec('Por qué te importa', c.porQueImporta ? '<p>' + fmt(c.porQueImporta) + '</p>' : '');
    if (c.reglas && c.reglas.length) {
      h += sec('Reglas de negocio', '<ul class="rules">' + c.reglas.map(function (r) {
        return '<li class="rule' + (r.principal ? ' main' : '') + '">' + (r.codigo ? '<span class="rule-code">' + esc(r.codigo) + '</span>' : '') +
          '<span class="rule-name">' + fmt(r.nombre || '') + '</span>' + (r.texto ? '<p>' + fmt(r.texto) + '</p>' : '') + '</li>';
      }).join('') + '</ul>');
    }
    if (c.ejemplo) {
      var e = c.ejemplo;
      h += sec('Ejemplo real', '<div class="ex">' + (e.titulo ? '<p class="ex-title">' + fmt(e.titulo) + '</p>' : '') +
        (e.filas && e.filas.length ? '<table><tbody>' + e.filas.map(function (f) {
          return '<tr' + (f[2] ? ' class="' + esc(f[2]) + '"' : '') + '><td>' + fmt(f[0]) + '</td><td>' + fmt(f[1]) + '</td></tr>';
        }).join('') + '</tbody></table>' : '') +
        (e.conclusion ? '<p class="ex-note">' + fmt(e.conclusion) + '</p>' : '') + '</div>');
    }
    h += sec('Para recordar', list(c.puntos));
    return h;
  }
  function renderTecnica(t) {
    var h = '';
    h += t.resumen ? '<p class="lead">' + fmt(t.resumen) + '</p>' : '';
    h += sec('Componentes', kv(t.componentes, 'nombre', 'rol'));
    h += sec('Colas y trabajos', kv(t.colas, 'cola', 'trabajos', 'nota'));
    h += sec('Puertos (adaptadores)', kv(t.puertos, 'nombre', 'rol'));
    h += sec('Seguridad', list(t.seguridad));
    if (t.fragmento && t.fragmento.codigo) h += sec(t.fragmento.titulo || 'Fragmento', '<pre class="code"><code>' + esc(t.fragmento.codigo) + '</code></pre>');
    return h;
  }

  function renderPanel(id) {
    var i = info(id), d = i.data, h = '';
    var vistaNombre = state.vista === 'tecnica' ? 'Técnica' : 'Contador';
    h += '<div class="panel-head"><div class="panel-icon" aria-hidden="true">' + esc(i.icono) + '</div><div class="grow">' +
      '<span class="badge">' + (i.tipo === 'zona' ? 'Zona' : 'Estación de la cinta') + '</span> <span class="badge vista">Vista ' + vistaNombre + '</span>' +
      '<h2 id="panel-title" tabindex="-1">' + esc(i.titulo) + '</h2></div>' +
      '<button type="button" class="btn btn-icon btn-sm panel-close" data-act="cerrar" aria-label="Cerrar detalle">✕</button></div>';
    if (d.resumen) h += '<p class="lead">' + fmt(d.resumen) + '</p>';
    if (i.pendiente) {
      h += pendBox('Contenido en preparación', ' Pronto verás aquí qué pasa en esta parte de la planta.');
    } else {
      var v = d[state.vista];
      if (v) h += state.vista === 'tecnica' ? renderTecnica(v) : renderContador(v);
      else h += pendBox('Contenido en preparación', ' Esta vista aún no tiene texto. Prueba la vista ' + (state.vista === 'tecnica' ? 'Contador.' : 'Técnica.'));
    }
    var rs = retosDe(id);
    if (rs.length) {
      h += sec('Mini-retos', '<div class="reto-links">' + rs.map(function (k) {
        var r = RETOS[k], pend = !!r.pendiente;
        return '<button type="button" class="btn reto-link" data-reto="' + esc(k) + '"' + (pend ? ' disabled' : '') + '>🎯 ' + esc(r.titulo || k) +
          '<small>' + (pend ? 'en preparación' : esc(TIPOS_RETO[r.tipo] || '')) + '</small></button>';
      }).join('') + '</div>');
    }
    panelInner.innerHTML = h;
  }
  function renderPanelVacio() {
    panelInner.innerHTML = '<div class="empty"><h2 id="panel-title" tabindex="-1">Explora la planta</h2>' +
      '<p>Toca o enfoca (Tab + Enter) cualquier estación o zona para ver qué hace. Cambia entre la vista <strong>Contador</strong> y la vista <strong>Técnica</strong> arriba.</p>' +
      '<p>¿Primera vez? Dale a <strong>▶ Tour</strong> y mira el recorrido completo.</p>' +
      '<div class="legend" aria-label="Leyenda de colores de los comprobantes">' +
      '<div><span style="background:var(--raw)"></span>Recién descargado, sin revisar</div>' +
      '<div><span style="background:var(--bad);border-radius:50%"></span>Marcado por una regla</div>' +
      '<div><span style="background:var(--fixed)"></span>Revisado por el motor</div>' +
      '<div><span style="background:var(--dg)"></span>DG · <span style="background:var(--dgng)"></span>DGNG · <span style="background:var(--dng)"></span>DNG</div>' +
      '</div></div>';
  }

  /* ---------------------------------------------------------------- índice */
  function buildIndex() {
    function chip(s) {
      var i = info(s.id);
      return '<li><button type="button" class="chip" data-id="' + s.id + '" aria-current="false"><span aria-hidden="true">' + esc(i.icono) + '</span>' + esc(i.titulo) +
        (i.pendiente ? '<span class="dot" aria-hidden="true" title="En preparación"></span><span class="sr">(en preparación)</span>' : '') + '</button></li>';
    }
    $('#idx-estaciones').innerHTML = SCENE.filter(function (s) { return s.tipo === 'estacion'; }).map(chip).join('');
    $('#idx-zonas').innerHTML = SCENE.filter(function (s) { return s.tipo === 'zona'; }).map(chip).join('');
  }

  /* ---------------------------------------------------------------- diálogo y retos */
  var dlg = $('#dlg'), dlgInner = $('#dlg-inner'), dlgOpener = null;

  function openDlg() {
    if (!dlg.open) {
      dlgOpener = document.activeElement;
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    }
    var h = $('#dlg-title', dlg); if (h) h.focus();
  }
  function closeDlg() {
    if (typeof dlg.close === 'function' && dlg.open) dlg.close(); else dlg.removeAttribute('open');
  }
  dlg.addEventListener('close', function () {
    dlgInner.innerHTML = '';
    if (dlgOpener && document.body.contains(dlgOpener)) { try { dlgOpener.focus(); } catch (e) { /* nada */ } }
  });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) closeDlg(); });

  function dlgHead(badge, titulo) {
    return '<div class="dlg-head"><div class="grow"><span class="badge">' + esc(badge) + '</span><h2 id="dlg-title" tabindex="-1">' + esc(titulo) + '</h2></div>' +
      '<button type="button" class="btn btn-icon btn-sm" data-dlg="cerrar" aria-label="Cerrar">✕</button></div>';
  }

  function openRetoList() {
    if (tour.on) pauseTour();
    var ids = Object.keys(RETOS);
    var h = dlgHead('Mini-retos', 'Pon a prueba lo aprendido');
    h += ids.length ? '<ul class="reto-list">' + ids.map(function (k) {
      var r = RETOS[k], pend = !!r.pendiente, est = r.estacion ? info(r.estacion).titulo : '';
      return '<li><button type="button" class="btn" data-reto="' + esc(k) + '"' + (pend ? ' disabled' : '') + '>🎯 ' + esc(r.titulo || k) +
        '<small>' + (pend ? 'en preparación' : esc(est)) + '</small></button></li>';
    }).join('') + '</ul>' : '<p>Aún no hay retos.</p>';
    dlgInner.innerHTML = h;
    openDlg();
  }

  function openReto(id) {
    var r = RETOS[id];
    if (!r) return;
    if (tour.on) pauseTour();
    var h = dlgHead('Mini-reto · ' + (TIPOS_RETO[r.tipo] || r.tipo), r.titulo || id);
    if (r.pendiente) {
      dlgInner.innerHTML = h + pendBox('Contenido en preparación', ' Este reto todavía se está armando.');
      openDlg(); return;
    }
    h += r.enunciado ? '<p>' + fmt(r.enunciado) + '</p>' : '';
    h += '<div id="reto-body"></div><p class="sr" id="reto-live" aria-live="polite"></p><div class="feedback" id="reto-fb" role="status"></div>' +
      '<div class="dlg-foot">' +
      (r.estacion && BY_ID[r.estacion] ? '<button type="button" class="btn btn-sm" data-ver="' + esc(r.estacion) + '">Ver estación</button>' : '') +
      '<button type="button" class="btn" id="reto-retry" hidden>Reintentar</button>' +
      '<button type="button" class="btn btn-primary" id="reto-check">Comprobar</button></div>';
    dlgInner.innerHTML = h;
    var ctx = {
      r: r, body: $('#reto-body', dlg), fb: $('#reto-fb', dlg), check: $('#reto-check', dlg), retry: $('#reto-retry', dlg),
      live: function (t) { var l = $('#reto-live', dlg); l.textContent = ''; setTimeout(function () { l.textContent = t; }, 30); },
      feedback: function (cls, html) { this.fb.className = 'feedback ' + cls; this.fb.innerHTML = html; },
      done: function () { this.check.hidden = true; this.retry.hidden = false; }
    };
    ctx.retry.addEventListener('click', function () { openReto(id); });
    var fn = RENDER_RETO[r.tipo];
    if (!fn) { ctx.body.innerHTML = pendBox('Tipo de reto desconocido', ' "' + r.tipo + '"'); ctx.check.hidden = true; }
    else fn(ctx);
    openDlg();
  }

  var RENDER_RETO = {
    /* --- opcion: una respuesta correcta entre varias --- */
    opcion: function (ctx) {
      var r = ctx.r, ops = r.opciones || [];
      ctx.body.innerHTML = '<fieldset class="opts"><legend class="sr">Opciones</legend>' + ops.map(function (o, k) {
        return '<label class="opt" data-k="' + k + '"><input type="radio" name="reto-op" value="' + k + '">' + fmt(o.texto) + '<span class="expl" hidden></span></label>';
      }).join('') + '</fieldset>';
      ctx.check.addEventListener('click', function () {
        var sel = $('input[name="reto-op"]:checked', ctx.body);
        if (!sel) { ctx.feedback('info', 'Elige una opción primero.'); return; }
        var k = +sel.value, acierto = !!ops[k].correcta;
        $$('.opt', ctx.body).forEach(function (lab, j) {
          var o = ops[j], ex = $('.expl', lab);
          $('input', lab).disabled = true;
          if (o.correcta) lab.classList.add('ok'); else if (j === k) lab.classList.add('bad');
          if (o.explicacion) { ex.innerHTML = (o.correcta ? '<span class="mark-ok">✓ </span>' : '<span class="mark-bad">✗ </span>') + fmt(o.explicacion); ex.hidden = false; }
        });
        ctx.feedback(acierto ? 'ok' : 'bad', (acierto ? '<strong>¡Correcto!</strong> ' : '<strong>No es esa.</strong> ') + fmt(r.explicacion || ''));
        ctx.done();
      });
    },

    /* --- numero: monto con tolerancia --- */
    numero: function (ctx) {
      var r = ctx.r, intentos = 0;
      var h = '';
      if (r.datos && r.datos.length) h += '<table class="data-table"><tbody>' + r.datos.map(function (f) { return '<tr><td>' + fmt(f[0]) + '</td><td>' + fmt(f[1]) + '</td></tr>'; }).join('') + '</tbody></table>';
      h += '<div class="num-row"><label for="reto-num">' + esc(r.etiqueta || 'Tu respuesta') + (r.unidad ? ' (' + esc(r.unidad) + ')' : '') + '</label>' +
        '<input class="num-in" id="reto-num" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"></div>';
      ctx.body.innerHTML = h;
      var inp = $('#reto-num', ctx.body);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ctx.check.click(); } });
      function solucion() {
        ctx.feedback('info', '<strong>Respuesta: ' + esc(r.unidad ? r.unidad + ' ' : '') + Number(r.respuesta).toFixed(2) + '.</strong> ' + fmt(r.explicacion || ''));
        inp.disabled = true; ctx.done();
      }
      ctx.check.addEventListener('click', function () {
        var v = parseFloat(String(inp.value).replace(/s\/|\s/gi, '').replace(',', '.'));
        if (isNaN(v)) { ctx.feedback('info', 'Escribe un número, por ejemplo 12.34.'); inp.focus(); return; }
        var tol = typeof r.tolerancia === 'number' ? r.tolerancia : 0.01;
        var bien = (Array.isArray(r.rango) && r.rango.length === 2)
          ? (v >= r.rango[0] - 1e-9 && v <= r.rango[1] + 1e-9)
          : Math.abs(v - Number(r.respuesta)) <= tol + 1e-9;
        if (bien) {
          ctx.feedback('ok', '<strong>¡Correcto!</strong> ' + fmt(r.explicacion || ''));
          inp.disabled = true; ctx.done();
        } else {
          intentos++;
          ctx.feedback('bad', '<strong>Todavía no.</strong> ' + fmt(r.pista || 'Revisa el cálculo.') +
            (intentos >= 2 ? ' <button type="button" class="btn btn-sm" id="reto-sol">Ver solución</button>' : ''));
          var b = $('#reto-sol', ctx.fb); if (b) b.addEventListener('click', solucion);
          inp.focus(); inp.select();
        }
      });
    },

    /* --- clasificar: ítems a categorías (arrastrar, tocar o teclado) --- */
    clasificar: function (ctx) {
      var r = ctx.r, cats = r.categorias || [], items = r.items || [];
      var place = items.map(function () { return null; }), sel = -1, checked = false;
      var catName = {}; cats.forEach(function (c) { catName[c.id] = c.nombre || c.id; });

      ctx.body.innerHTML = '<p class="cl-help">Arrastra cada comprobante a su columna, o tócalo (Enter) y luego toca la columna.</p>' +
        '<div class="cl-pool" data-drop=""><p class="cl-pool-label">Sin clasificar</p><ul class="cl-list" data-list=""></ul>' +
        '<button type="button" class="btn btn-sm" data-target="" hidden>Devolver aquí</button></div>' +
        '<div class="cl-zones">' + cats.map(function (c) {
          return '<div class="cl-zone" data-drop="' + esc(c.id) + '"><div class="cl-zone-head">' +
            '<button type="button" class="btn btn-sm" data-target="' + esc(c.id) + '" aria-label="Mover a ' + esc(c.nombre || c.id) + '">' + esc(c.nombre || c.id) + '</button>' +
            (c.ayuda ? '<small>' + fmt(c.ayuda) + '</small>' : '') + '</div><ul class="cl-list" data-list="' + esc(c.id) + '"></ul></div>';
        }).join('') + '</div>';

      function itemHtml(it, k) {
        return '<li><button type="button" class="cl-item" data-k="' + k + '" aria-pressed="' + (sel === k) + '">' + fmt(it.texto) +
          (it.detalle ? '<small>' + fmt(it.detalle) + '</small>' : '') + '<span class="expl" hidden></span></button></li>';
      }
      function paint(focusK) {
        $$('[data-list]', ctx.body).forEach(function (ul) {
          var cat = ul.getAttribute('data-list'), h = '';
          items.forEach(function (it, k) { if ((place[k] || '') === cat) h += itemHtml(it, k); });
          ul.innerHTML = h;
        });
        var poolBtn = $('.cl-pool [data-target]', ctx.body);
        poolBtn.hidden = !(sel >= 0 && place[sel] !== null);
        if (focusK != null) { var b = $('.cl-item[data-k="' + focusK + '"]', ctx.body); if (b) b.focus(); }
      }
      function moveTo(k, cat) {
        if (checked || k < 0) return;
        place[k] = cat === '' ? null : cat; sel = -1; paint(k);
        ctx.live(stripTags(items[k].texto) + ' → ' + (cat ? catName[cat] : 'sin clasificar'));
      }
      function stripTags(s) { return String(s).replace(/\*\*|`/g, ''); }

      ctx.body.addEventListener('click', function (e) {
        if (checked) return;
        if (justDragged) return;
        var it = e.target.closest('.cl-item');
        if (it) {
          var k = +it.getAttribute('data-k');
          sel = sel === k ? -1 : k; paint(k);
          if (sel >= 0) ctx.live('Elegiste: ' + stripTags(items[k].texto) + '. Ahora elige la columna.');
          return;
        }
        var t = e.target.closest('[data-target]');
        var zone = t || e.target.closest('[data-drop]');
        if (zone) {
          var cat = t ? t.getAttribute('data-target') : zone.getAttribute('data-drop');
          if (sel < 0) { ctx.live('Primero elige un comprobante.'); if (t) ctx.feedback('info', 'Primero elige un comprobante.'); return; }
          moveTo(sel, cat);
        }
      });

      /* arrastre con Pointer Events (mouse + táctil) */
      var drag = null, justDragged = false;
      ctx.body.addEventListener('pointerdown', function (e) {
        if (checked || e.button !== 0) return;
        var it = e.target.closest('.cl-item'); if (!it) return;
        drag = { k: +it.getAttribute('data-k'), el: it, x: e.clientX, y: e.clientY, id: e.pointerId, ghost: null, over: null };
      });
      function zoneAt(x, y) { var el = document.elementFromPoint(x, y); return el ? el.closest('[data-drop]') : null; }
      function onMove(e) {
        if (!drag || e.pointerId !== drag.id) return;
        if (!drag.ghost) {
          if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 8) return;
          var g = drag.el.cloneNode(true); g.classList.add('cl-ghost'); g.removeAttribute('data-k');
          g.style.width = drag.el.getBoundingClientRect().width + 'px';
          dlg.appendChild(g); drag.ghost = g;
          try { drag.el.setPointerCapture(e.pointerId); } catch (err) { /* sin captura */ }
        }
        e.preventDefault();
        drag.ghost.style.left = (e.clientX - 20) + 'px'; drag.ghost.style.top = (e.clientY - 16) + 'px';
        var z = zoneAt(e.clientX, e.clientY);
        if (z !== drag.over) { if (drag.over) drag.over.classList.remove('over'); if (z) z.classList.add('over'); drag.over = z; }
      }
      function onUp(e) {
        if (!drag || e.pointerId !== drag.id) return;
        var d = drag; drag = null;
        if (!d.ghost) return;
        d.ghost.remove(); if (d.over) d.over.classList.remove('over');
        justDragged = true; setTimeout(function () { justDragged = false; }, 0);
        var z = e.type === 'pointerup' ? zoneAt(e.clientX, e.clientY) : null;
        if (z) moveTo(d.k, z.getAttribute('data-drop'));
      }
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      dlg.addEventListener('close', function off() {
        document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp); dlg.removeEventListener('close', off);
      });

      paint();
      ctx.check.addEventListener('click', function () {
        var faltan = place.filter(function (p) { return p === null; }).length;
        if (faltan) { ctx.feedback('info', 'Te ' + (faltan === 1 ? 'falta 1 comprobante' : 'faltan ' + faltan + ' comprobantes') + ' por ubicar.'); return; }
        checked = true; sel = -1; paint();
        var ok = 0;
        items.forEach(function (it, k) {
          var b = $('.cl-item[data-k="' + k + '"]', ctx.body), good = place[k] === it.categoria, ex = $('.expl', b);
          if (good) ok++;
          b.classList.add(good ? 'ok' : 'bad'); b.setAttribute('aria-disabled', 'true');
          ex.innerHTML = (good ? '<span class="mark-ok">✓ </span>' : '<span class="mark-bad">✗ Va en ' + esc(catName[it.categoria] || it.categoria) + '. </span>') + fmt(it.explicacion || '');
          ex.hidden = false;
        });
        $$('[data-target]', ctx.body).forEach(function (b) { b.disabled = true; });
        ctx.feedback(ok === items.length ? 'ok' : 'bad', '<strong>Acertaste ' + ok + ' de ' + items.length + '.</strong> ' + fmt(r.explicacion || ''));
        ctx.done();
      });
    },

    /* --- encontrar: el ítem erróneo (modo "error") o dónde falta uno (modo "faltante") --- */
    encontrar: function (ctx) {
      var r = ctx.r, items = r.items || [], modo = r.modo === 'faltante' ? 'faltante' : 'error';
      ctx.check.hidden = true;
      var h = '<ul class="find-list">';
      items.forEach(function (it, k) {
        if (modo === 'error') {
          h += '<li><button type="button" class="find-item" data-k="' + k + '">' + fmt(it.texto) + (it.detalle ? ' <span class="empty">· ' + fmt(it.detalle) + '</span>' : '') + '<span class="expl" hidden></span></button></li>';
        } else {
          h += '<li><div class="find-item" data-k="' + k + '">' + fmt(it.texto) + (it.detalle ? ' <span class="empty">· ' + fmt(it.detalle) + '</span>' : '') + '<span class="expl" hidden></span></div></li>';
          if (k < items.length - 1) {
            h += '<li><button type="button" class="find-gap" data-gap="' + k + '" aria-label="¿Falta un comprobante entre ' + esc(stripF(it.texto)) + ' y ' + esc(stripF(items[k + 1].texto)) + '?">¿Falta aquí?</button></li>';
          }
        }
      });
      h += '</ul>';
      ctx.body.innerHTML = '<p class="cl-help">' + (modo === 'error' ? 'Toca el comprobante que tiene el problema.' : 'Toca el espacio donde falta un comprobante.') + '</p>' + h;
      function stripF(s) { return String(s).replace(/\*\*|`/g, ''); }
      function revelar() {
        items.forEach(function (it, k) {
          var el = $('.find-item[data-k="' + k + '"]', ctx.body), ex = $('.expl', el);
          if (it.explicacion) { ex.innerHTML = fmt(it.explicacion); ex.hidden = false; ex.className = 'expl'; }
          if (el.tagName === 'BUTTON') el.disabled = true;
        });
        $$('.find-gap', ctx.body).forEach(function (g) { g.disabled = true; });
      }
      ctx.body.addEventListener('click', function (e) {
        var b = e.target.closest(modo === 'error' ? 'button.find-item' : '.find-gap');
        if (!b || b.disabled) return;
        var acierto;
        if (modo === 'error') {
          var k = +b.getAttribute('data-k'); acierto = !!items[k].error;
          items.forEach(function (it, j) { var el = $('.find-item[data-k="' + j + '"]', ctx.body); if (it.error) el.classList.add('ok'); else if (j === k) el.classList.add('bad'); });
        } else {
          var gk = +b.getAttribute('data-gap'); acierto = !!(items[gk] && items[gk].faltaDespues);
          $$('.find-gap', ctx.body).forEach(function (g) {
            var j = +g.getAttribute('data-gap');
            if (items[j].faltaDespues) { g.classList.add('ok'); g.textContent = 'Aquí falta: ' + (r.respuestaFaltante || 'un comprobante'); }
            else if (j === gk) g.classList.add('bad');
          });
        }
        revelar();
        ctx.feedback(acierto ? 'ok' : 'bad', (acierto ? '<strong>¡Bien visto!</strong> ' : '<strong>No era ahí.</strong> ') +
          (modo === 'faltante' && r.respuestaFaltante ? 'Falta <strong>' + esc(r.respuestaFaltante) + '</strong>. ' : '') + fmt(r.explicacion || ''));
        ctx.done();
      });
    }
  };

  /* ---------------------------------------------------------------- tour guiado */
  var tour = { on: false, i: 0, playing: false, remaining: 0, dur: 0, t0: 0, timer: 0, raf: 0, voz: false };
  var narr = $('#narr');

  function stepInfo(s) {
    var pend = !!s.pendiente || !s.texto;
    var titulo = s.titulo || (s.target ? info(s.target).titulo : 'La planta de ContApp');
    var texto = pend ? 'Contenido en preparación.' : s.texto;
    var palabras = String(texto).split(/\s+/).length;
    var dur = s.duracion || (pend ? 3500 : Math.max(5000, Math.min(16000, palabras * 380)));
    return { titulo: titulo, texto: texto, dur: dur, pend: pend };
  }
  function highlight(id) {
    $$('.hit', svg).forEach(function (g) { g.classList.toggle('is-tour', !!id && g.getAttribute('data-id') === id); });
    svg.classList.toggle('touring', !!id);
  }
  function startTour(i) {
    if (!TOUR.length) return;
    tour.on = true; narr.hidden = false;
    $('#btn-tour').setAttribute('aria-pressed', 'true');
    goStep(i || 0, true);
    var top = $('#scene-wrap').getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.5) $('#scene-wrap').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
    $('#narr-title').focus({ preventScroll: true });
  }
  function goStep(i, play) {
    clearTimeout(tour.timer); cancelAnimationFrame(tour.raf);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    tour.i = Math.max(0, Math.min(TOUR.length - 1, i));
    var s = TOUR[tour.i], si = stepInfo(s);
    if (s.vista === 'contador' || s.vista === 'tecnica') setVista(s.vista);
    highlight(s.target || null);
    if (s.target) camFit(s.target, 700); else camTo({ x: 0, y: 0, w: FULL.w }, 700);
    if (s.target && s.abrirPanel && isWide()) openPanel(s.target, { fromTour: true, keepOpener: true });
    else if (isWide() && state.sel && state.sel !== s.target) { /* mantener panel pero sin desincronizar */ closePanelSilencioso(); }
    $('#narr-step').textContent = 'Paso ' + (tour.i + 1) + ' de ' + TOUR.length;
    $('#narr-title').textContent = si.titulo;
    var tx = $('#narr-text'); tx.textContent = si.texto;
    var body = $('.narr-body', narr); body.classList.remove('narr-fade'); void body.offsetWidth; body.classList.add('narr-fade');
    $('#tour-prev').disabled = tour.i === 0;
    tour.dur = si.dur; tour.remaining = si.dur;
    setBar(0);
    if (play === undefined) play = tour.playing;
    if (play) playTour(); else setPlayBtn(false);
  }
  function closePanelSilencioso() {
    state.sel = null; markSelected(null); renderPanelVacio();
  }
  function setBar(k) { $('#narr-bar').style.width = (Math.max(0, Math.min(1, k)) * 100).toFixed(1) + '%'; }
  function setPlayBtn(playing) {
    var b = $('#tour-play'), fin = !playing && tour.i === TOUR.length - 1 && tour.remaining <= 0;
    b.textContent = playing ? '⏸' : (fin ? '↻' : '▶');
    b.setAttribute('aria-label', playing ? 'Pausar tour' : (fin ? 'Repetir tour' : 'Reanudar tour'));
  }
  function playTour() {
    if (tour.i === TOUR.length - 1 && tour.remaining <= 0) { goStep(0, true); return; }
    tour.playing = true; setPlayBtn(true);
    tour.t0 = now();
    var s = TOUR[tour.i], si = stepInfo(s);
    if (tour.voz && window.speechSynthesis && !si.pend) {
      var u = new SpeechSynthesisUtterance(si.titulo + '. ' + si.texto);
      u.lang = 'es-PE'; u.rate = 1;
      var paso = tour.i;
      u.onend = function () { if (tour.on && tour.playing && tour.i === paso) tour.timer = setTimeout(nextStep, 700); };
      window.speechSynthesis.speak(u);
    } else {
      tour.timer = setTimeout(nextStep, tour.remaining);
    }
    (function tick() {
      if (!tour.playing) return;
      setBar((tour.dur - tour.remaining + (now() - tour.t0)) / tour.dur);
      tour.raf = requestAnimationFrame(tick);
    })();
  }
  function pauseTour() {
    if (!tour.playing) return;
    tour.playing = false;
    tour.remaining = Math.max(0, tour.remaining - (now() - tour.t0));
    clearTimeout(tour.timer); cancelAnimationFrame(tour.raf);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setPlayBtn(false);
  }
  function nextStep() {
    if (tour.i < TOUR.length - 1) goStep(tour.i + 1);
    else { tour.playing = false; tour.remaining = 0; cancelAnimationFrame(tour.raf); setBar(1); setPlayBtn(false); }
  }
  function prevStep() { if (tour.i > 0) goStep(tour.i - 1); }
  function exitTour() {
    pauseTour();
    tour.on = false; narr.hidden = true; highlight(null);
    $('#btn-tour').setAttribute('aria-pressed', 'false');
    camTo({ x: 0, y: 0, w: FULL.w }, 500);
    $('#btn-tour').focus();
  }

  /* ---------------------------------------------------------------- tema */
  function temaActual() {
    var a = document.documentElement.getAttribute('data-theme');
    if (a === 'light' || a === 'dark') return a;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncTemaBtn() {
    var b = $('#btn-tema'), t = temaActual();
    b.setAttribute('aria-label', t === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
    b.title = b.getAttribute('aria-label');
  }

  /* ---------------------------------------------------------------- validación de datos (avisos para quien escribe contenido) */
  function validar() {
    var avisos = [];
    Object.keys(EST).forEach(function (k) { if (!BY_ID[k]) avisos.push('estaciones: id "' + k + '" no existe en la escena'); });
    SCENE.forEach(function (s) { if (!EST[s.id]) avisos.push('estaciones: falta el id "' + s.id + '"'); });
    Object.keys(RETOS).forEach(function (k) {
      var r = RETOS[k];
      if (!r || !TIPOS_RETO[r.tipo]) avisos.push('retos: "' + k + '" tiene tipo inválido');
      else if (r.estacion && !BY_ID[r.estacion]) avisos.push('retos: "' + k + '" apunta a estación inexistente "' + r.estacion + '"');
      else if (!r.pendiente) {
        if (r.tipo === 'opcion' && !(r.opciones || []).some(function (o) { return o.correcta; })) avisos.push('retos: "' + k + '" no tiene opción correcta');
        if (r.tipo === 'numero' && typeof r.respuesta !== 'number') avisos.push('retos: "' + k + '" necesita respuesta numérica');
        if (r.tipo === 'clasificar') {
          var ids = (r.categorias || []).map(function (c) { return c.id; });
          (r.items || []).forEach(function (it, j) { if (ids.indexOf(it.categoria) < 0) avisos.push('retos: "' + k + '" ítem ' + j + ' con categoría inválida'); });
        }
        if (r.tipo === 'encontrar' && !(r.items || []).some(function (it) { return r.modo === 'faltante' ? it.faltaDespues : it.error; })) avisos.push('retos: "' + k + '" no marca la respuesta');
      }
    });
    TOUR.forEach(function (s, j) { if (s.target && !BY_ID[s.target]) avisos.push('tour: paso ' + j + ' apunta a "' + s.target + '" (no existe)'); });
    if (avisos.length && window.console) console.warn('[Planta ContApp] Revisa los datos:\n- ' + avisos.join('\n- '));
  }

  /* ---------------------------------------------------------------- eventos */
  function bind() {
    svg.addEventListener('click', function (e) {
      if (suppressClick) return;
      var g = e.target.closest('.hit'); if (g) openPanel(g.getAttribute('data-id'));
    });
    svg.addEventListener('keydown', function (e) {
      var g = e.target.closest && e.target.closest('.hit');
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPanel(g.getAttribute('data-id')); }
    });
    $('#indice').addEventListener('click', function (e) {
      var c = e.target.closest('.chip'); if (c) { openPanel(c.getAttribute('data-id')); if (isWide()) camFit(c.getAttribute('data-id'), 500); }
    });
    panel.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act="cerrar"]'); if (t) { closePanel(); return; }
      var r = e.target.closest('[data-reto]'); if (r && !r.disabled) openReto(r.getAttribute('data-reto'));
    });
    dlg.addEventListener('click', function (e) {
      if (e.target.closest('[data-dlg="cerrar"]')) { closeDlg(); return; }
      var r = e.target.closest('.reto-list [data-reto]'); if (r && !r.disabled) { openReto(r.getAttribute('data-reto')); return; }
      var v = e.target.closest('[data-ver]');
      if (v) { var id = v.getAttribute('data-ver'); closeDlg(); openPanel(id); camFit(id, 500); }
    });
    $$('.seg-btn').forEach(function (b) { b.addEventListener('click', function () { setVista(b.getAttribute('data-vista')); }); });
    $('#btn-cinta').addEventListener('click', function () { setBelt(!belt.running); });
    $('#btn-tema').addEventListener('click', function () {
      var t = temaActual() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', t); store('planta-tema', t); syncTemaBtn();
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', syncTemaBtn);
    }
    $('#btn-retos').addEventListener('click', openRetoList);
    $('#btn-tour').addEventListener('click', function () { if (tour.on) exitTour(); else startTour(0); });
    $('#tour-next').addEventListener('click', function () { nextStepManual(); });
    $('#tour-prev').addEventListener('click', prevStep);
    $('#tour-play').addEventListener('click', function () { if (tour.playing) pauseTour(); else playTour(); });
    $('#tour-exit').addEventListener('click', exitTour);
    if ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) {
      var vz = $('#tour-voz'); vz.hidden = false;
      vz.addEventListener('click', function () {
        tour.voz = !tour.voz;
        vz.setAttribute('aria-pressed', String(tour.voz)); vz.textContent = tour.voz ? '🔊' : '🔈';
        vz.setAttribute('aria-label', tour.voz ? 'Desactivar narración por voz' : 'Activar narración por voz');
        if (tour.on) goStep(tour.i, tour.playing);
      });
    }
    $('#zoom-in').addEventListener('click', function () { camZoom(1 / 1.4); });
    $('#zoom-out').addEventListener('click', function () { camZoom(1.4); });
    $('#zoom-reset').addEventListener('click', function () { camTo({ x: 0, y: 0, w: FULL.w }, 350); });

    document.addEventListener('keydown', function (e) {
      if (dlg.open) return;
      var tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === 'Escape') {
        if (!isWide() && panel.classList.contains('open')) { closePanel(); return; }
        if (tour.on) { exitTour(); return; }
        if (state.sel) closePanel();
      }
      if (tour.on && e.key === 'ArrowRight') { e.preventDefault(); nextStepManual(); }
      if (tour.on && e.key === 'ArrowLeft') { e.preventDefault(); prevStep(); }
    });
    window.addEventListener('resize', function () {
      if (isWide()) { panel.classList.remove('open'); document.body.classList.remove('sheet-open'); }
    });
  }
  function nextStepManual() {
    if (tour.i < TOUR.length - 1) goStep(tour.i + 1);
    else { pauseTour(); tour.remaining = 0; setBar(1); setPlayBtn(false); }
  }

  /* ---------------------------------------------------------------- inicio */
  function init() {
    buildScene();
    buildIndex();
    renderPanelVacio();
    initPan();
    bind();
    setVista(state.vista);
    syncTemaBtn();
    setCards();
    setBelt(belt.running);
    validar();
  }
  init();

  /* API mínima para depurar desde la consola */
  window.PlantaContApp = { abrir: openPanel, reto: openReto, tour: startTour, vista: setVista };
})();
