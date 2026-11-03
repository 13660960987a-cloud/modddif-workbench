// Brush mask for the pending projection: paint on top of the locked preview to choose which part
// of the generated image gets baked. White = project, black = keep what is already on the model.
// The mask lives in the generated image's own pixel space, so it stays aligned with the projection.

export function createBrushMask({ overlay, image, onChange = () => {} }) {
  const W = 1024, H = 1024;
  const mask = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const mctx = mask.getContext('2d');
  const view = Object.assign(document.createElement('canvas'), { className: 'brush-canvas' });
  const cursor = Object.assign(document.createElement('div'), { className: 'brush-cursor' });
  overlay.append(view, cursor);
  const state = { enabled: false, mode: 'paint', size: 60, hardness: .6, painting: false, last: null, dirty: false };
  const history = [];

  function reset(fill) { mctx.globalCompositeOperation = 'source-over'; mctx.fillStyle = fill ? '#fff' : '#000'; mctx.fillRect(0, 0, W, H); state.dirty = !fill; redraw(); onChange(); }
  reset(false); state.dirty = false;

  // The overlay shows the image with object-fit: contain; map pointer positions into image space.
  function imageRect() {
    const r = overlay.getBoundingClientRect(), iw = image.naturalWidth || 1, ih = image.naturalHeight || 1;
    const s = Math.min(r.width / iw, r.height / ih), w = iw * s, h = ih * s;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h, scale: s };
  }
  function toMask(e) { const r = imageRect(); return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H, r }; }
  function redraw() {
    const r = overlay.getBoundingClientRect();
    view.width = Math.max(1, Math.round(r.width)); view.height = Math.max(1, Math.round(r.height));
    const v = view.getContext('2d'); v.clearRect(0, 0, view.width, view.height);
    if (!state.enabled && !state.dirty) return;
    const ir = imageRect();
    // Red tint where nothing will be projected, so the painted area reads as "kept".
    const tint = document.createElement('canvas'); tint.width = W; tint.height = H; const t = tint.getContext('2d');
    t.fillStyle = 'rgba(220,60,50,.45)'; t.fillRect(0, 0, W, H); t.globalCompositeOperation = 'destination-out'; t.drawImage(mask, 0, 0);
    v.drawImage(tint, ir.left - r.left, ir.top - r.top, ir.width, ir.height);
  }
  function stamp(p) {
    const radius = state.size / 2 / imageRect().scale * (W / (image.naturalWidth || W));
    const g = mctx.createRadialGradient(p.x, p.y, radius * state.hardness, p.x, p.y, radius);
    const c = state.mode === 'paint' ? '255,255,255' : '0,0,0';
    g.addColorStop(0, `rgba(${c},1)`); g.addColorStop(1, `rgba(${c},0)`);
    mctx.globalCompositeOperation = 'source-over'; mctx.fillStyle = g; mctx.beginPath(); mctx.arc(p.x, p.y, radius, 0, Math.PI * 2); mctx.fill();
  }
  function line(a, b) { const d = Math.hypot(b.x - a.x, b.y - a.y), step = Math.max(1, state.size / 8), n = Math.ceil(d / step); for (let i = 1; i <= n; i++) stamp({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }); }
  function moveCursor(e) { const r = overlay.getBoundingClientRect(); cursor.style.width = cursor.style.height = state.size + 'px'; cursor.style.left = (e.clientX - r.left - state.size / 2) + 'px'; cursor.style.top = (e.clientY - r.top - state.size / 2) + 'px'; cursor.dataset.mode = state.mode; }

  view.addEventListener('pointerdown', e => {
    if (!state.enabled || e.button !== 0) return;
    e.preventDefault(); view.setPointerCapture(e.pointerId);
    history.push(mctx.getImageData(0, 0, W, H)); if (history.length > 20) history.shift();
    state.painting = true; state.dirty = true; const p = toMask(e); stamp(p); state.last = p; redraw();
  });
  view.addEventListener('pointermove', e => { moveCursor(e); if (!state.painting) return; const p = toMask(e); line(state.last, p); state.last = p; redraw(); });
  const end = () => { if (state.painting) { state.painting = false; onChange(); } };
  view.addEventListener('pointerup', end); view.addEventListener('pointercancel', end);
  view.addEventListener('pointerleave', () => { cursor.hidden = true; end(); });
  view.addEventListener('pointerenter', () => { cursor.hidden = !state.enabled; });
  // [ and ] resize the brush while painting; X swaps paint/erase (common in paint tools).
  window.addEventListener('keydown', e => {
    if (!state.enabled || e.target.closest?.('input,textarea,select')) return;
    if (e.key === '[') { state.size = Math.max(6, state.size * .8); onChange(); }
    else if (e.key === ']') { state.size = Math.min(600, state.size * 1.25); onChange(); }
    else if (e.key.toLowerCase() === 'x') { state.mode = state.mode === 'paint' ? 'erase' : 'paint'; onChange(); }
    else return;
    e.preventDefault(); e.stopPropagation(); cursor.style.width = cursor.style.height = state.size + 'px'; cursor.dataset.mode = state.mode;
  }, true);
  new ResizeObserver(redraw).observe(overlay);

  return {
    get state() { return { ...state }; },
    setEnabled(on) { state.enabled = on; view.classList.toggle('active', on); cursor.hidden = !on; redraw(); onChange(); },
    setMode(m) { state.mode = m; onChange(); },
    setSize(px) { state.size = px; onChange(); },
    setHardness(h) { state.hardness = h; },
    fillAll() { history.push(mctx.getImageData(0, 0, W, H)); reset(true); },
    clear() { history.push(mctx.getImageData(0, 0, W, H)); reset(false); },
    invert() { history.push(mctx.getImageData(0, 0, W, H)); const d = mctx.getImageData(0, 0, W, H); for (let i = 0; i < d.data.length; i += 4) { const v = 255 - d.data[i]; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; } mctx.putImageData(d, 0, 0); state.dirty = true; redraw(); onChange(); },
    undo() { const d = history.pop(); if (!d) return false; mctx.putImageData(d, 0, 0); redraw(); onChange(); return true; },
    /** Share of the image that will be projected (0–1). */
    coverage() { const d = mctx.getImageData(0, 0, 64, 64).data, s = mctx; const small = document.createElement('canvas'); small.width = small.height = 64; small.getContext('2d').drawImage(mask, 0, 0, 64, 64); const p = small.getContext('2d').getImageData(0, 0, 64, 64).data; let t = 0; for (let i = 0; i < p.length; i += 4) t += p[i]; return t / (64 * 64 * 255); },
    isActive() { return state.dirty; },
    /** The pending image with the mask multiplied into alpha, at the image's native size. */
    async apply(url) {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('无法读取待投射图片。')); i.src = url; });
      const c = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight }), x = c.getContext('2d');
      x.drawImage(img, 0, 0); x.globalCompositeOperation = 'destination-in';
      // Mask is greyscale; turn luminance into alpha before compositing.
      const a = Object.assign(document.createElement('canvas'), { width: W, height: H }), ax = a.getContext('2d'), md = mctx.getImageData(0, 0, W, H);
      for (let i = 0; i < md.data.length; i += 4) { md.data[i + 3] = md.data[i]; md.data[i] = md.data[i + 1] = md.data[i + 2] = 255; }
      ax.putImageData(md, 0, 0); x.drawImage(a, 0, 0, c.width, c.height);
      const out = c.toDataURL('image/png'); c.width = c.height = a.width = a.height = 0; return out;
    },
    destroy() { view.remove(); cursor.remove(); },
  };
}
