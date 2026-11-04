// Roughness / metalness brush: paint straight onto the model in the viewport. Each stroke is a
// screen-space RGBA image (value in RGB, coverage in alpha) that the scene projects into UV space,
// so strokes follow the surface, respect occlusion and cross UV seams cleanly.
//
// "杂乱度" breaks up coverage with fractal noise and "数值抖动" varies the value along the stroke, so
// painted wear looks organic instead of uniform.

function noiseCanvas(w, h, seed) {
  // Fractal value noise, tiled across the screen; regenerated per stroke so strokes do not repeat.
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h }), x = c.getContext('2d');
  let s = seed * 9301 + 49297; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  x.fillStyle = '#808080'; x.fillRect(0, 0, w, h);
  for (const [cell, amp] of [[64, .55], [24, .3], [8, .15]]) {
    const gw = Math.ceil(w / cell) + 1, gh = Math.ceil(h / cell) + 1, g = document.createElement('canvas');
    g.width = gw; g.height = gh; const gx = g.getContext('2d'), id = gx.createImageData(gw, gh);
    for (let i = 0; i < gw * gh; i++) { const v = rnd() * 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    gx.putImageData(id, 0, 0); x.globalAlpha = amp; x.imageSmoothingEnabled = true; x.drawImage(g, 0, 0, gw * cell, gh * cell);
  }
  x.globalAlpha = 1; return x.getImageData(0, 0, w, h).data;
}

export function createOrmBrush({ host, onStroke, onChange = () => {}, setOrbit = () => {} }) {
  const view = Object.assign(document.createElement('canvas'), { className: 'orm-brush-canvas' });
  const cursor = Object.assign(document.createElement('div'), { className: 'brush-cursor' });
  cursor.hidden = true; host.append(view, cursor);
  const st = { enabled: false, mode: 'paint', value: .25, size: 70, hardness: .4, flow: .6, scatter: .5, jitter: .15, painting: false, last: null, orbitHeld: false };
  let stroke = null, sctx = null, w = 1, h = 1, seed = 1;

  function resize() { const r = host.getBoundingClientRect(); w = view.width = Math.max(1, Math.round(r.width)); h = view.height = Math.max(1, Math.round(r.height)); }
  new ResizeObserver(resize).observe(host); resize();
  const local = e => { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function stamp(p) {
    const r = st.size / 2, g = sctx.createRadialGradient(p.x, p.y, r * st.hardness, p.x, p.y, r);
    g.addColorStop(0, `rgba(255,255,255,${st.flow})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    sctx.fillStyle = g; sctx.beginPath(); sctx.arc(p.x, p.y, r, 0, Math.PI * 2); sctx.fill();
  }
  function line(a, b) { const d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(d / Math.max(1, st.size / 6))); for (let i = 1; i <= n; i++) stamp({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }); }
  function preview() {
    const v = view.getContext('2d'); v.clearRect(0, 0, w, h); if (!stroke) return;
    v.globalAlpha = .55; v.drawImage(stroke, 0, 0);
    v.globalCompositeOperation = 'source-in'; v.fillStyle = st.mode === 'erase' ? '#f08a7a' : `rgb(${Math.round(st.value * 255)},${Math.round(80 + st.value * 120)},255)`; v.fillRect(0, 0, w, h);
    v.globalCompositeOperation = 'source-over'; v.globalAlpha = 1;
  }
  // Final stroke image: value in RGB (with jitter), coverage × noise in alpha.
  function buildImage() {
    const sd = sctx.getImageData(0, 0, w, h).data, nz = noiseCanvas(w, h, seed++);
    const out = Object.assign(document.createElement('canvas'), { width: w, height: h }), ox = out.getContext('2d'), od = ox.createImageData(w, h), o = od.data;
    let any = 0;
    for (let q = 0; q < o.length; q += 4) {
      const a = sd[q + 3] / 255; if (!a) continue;
      const n = nz[q] / 255;
      const cov = a * (1 - st.scatter + st.scatter * Math.min(1, Math.max(0, (n - .35) * 2.2)));
      const v = Math.min(1, Math.max(0, st.value + (n - .5) * 2 * st.jitter));
      o[q] = o[q + 1] = o[q + 2] = Math.round(v * 255); o[q + 3] = Math.round(cov * 255); if (o[q + 3]) any++;
    }
    ox.putImageData(od, 0, 0);
    return any ? out.toDataURL('image/png') : null;
  }
  function cursorAt(e) { const p = local(e); cursor.style.width = cursor.style.height = st.size + 'px'; cursor.style.left = (p.x - st.size / 2) + 'px'; cursor.style.top = (p.y - st.size / 2) + 'px'; cursor.dataset.mode = st.mode; }

  view.addEventListener('pointerdown', e => {
    if (!st.enabled || st.orbitHeld || e.button !== 0) return;
    e.preventDefault(); view.setPointerCapture(e.pointerId);
    stroke = Object.assign(document.createElement('canvas'), { width: w, height: h }); sctx = stroke.getContext('2d');
    st.painting = true; const p = local(e); stamp(p); st.last = p; preview();
  });
  view.addEventListener('pointermove', e => { cursorAt(e); if (!st.painting) return; const p = local(e); line(st.last, p); st.last = p; preview(); });
  const end = async () => {
    if (!st.painting) return; st.painting = false;
    const img = buildImage(); const mode = st.mode; stroke = null; sctx = null;
    if (img) { view.classList.add('busy'); try { await onStroke({ image: img, mode, aspect: w / h }); } finally { view.classList.remove('busy'); } }
    preview(); onChange();
  };
  view.addEventListener('pointerup', end); view.addEventListener('pointercancel', end);
  view.addEventListener('pointerenter', () => { cursor.hidden = !st.enabled; });
  view.addEventListener('pointerleave', () => { cursor.hidden = true; });
  // Hold Space to orbit the camera without leaving brush mode.
  const key = (e, down) => {
    if (!st.enabled || e.target.closest?.('input,textarea,select')) return;
    if (e.code === 'Space') { st.orbitHeld = down; view.classList.toggle('orbit', down); setOrbit(down); e.preventDefault(); }
    else if (down && e.key === '[') { st.size = Math.max(6, st.size * .8); onChange(); e.preventDefault(); }
    else if (down && e.key === ']') { st.size = Math.min(500, st.size * 1.25); onChange(); e.preventDefault(); }
    else if (down && e.key.toLowerCase() === 'x') { st.mode = st.mode === 'paint' ? 'erase' : 'paint'; onChange(); e.preventDefault(); }
  };
  window.addEventListener('keydown', e => key(e, true), true); window.addEventListener('keyup', e => key(e, false), true);

  return {
    get state() { return { ...st }; },
    set(patch) { Object.assign(st, patch); onChange(); },
    setEnabled(on) { st.enabled = on; view.classList.toggle('active', on); cursor.hidden = true; setOrbit(!on); onChange(); },
    destroy() { view.remove(); cursor.remove(); },
  };
}
