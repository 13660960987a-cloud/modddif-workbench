// UV refinement: an image model redraws the unwrapped atlas with more detail, but it also drifts a
// few pixels, recolours regions and invents content in big empty islands. So only its fine detail
// is kept: detail = AI − blur(AI), added onto the current map inside each island, and islands that
// are flat in the current map (floors, caps) are skipped so nothing new is painted onto them.

const blurBox = (src, w, h, r) => {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), span = 2 * r + 1;
  for (let y = 0; y < h; y++) { let s = 0; const row = y * w; for (let i = -r; i <= r; i++) s += src[row + Math.min(w - 1, Math.max(0, i))]; for (let x = 0; x < w; x++) { tmp[row + x] = s / span; s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]; } }
  for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, i)) * w + x]; for (let y = 0; y < h; y++) { out[y * w + x] = s / span; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
  return out;
};
const blur = (src, w, h, r) => blurBox(blurBox(src, w, h, r), w, h, r);

/** Connected islands of a coverage mask (1 = UV surface). Returns label per pixel (0 = empty) and count. */
function islands(mask, w, h) {
  const label = new Int32Array(w * h), stack = new Int32Array(w * h); let n = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue; n++; let top = 0; stack[top++] = s; label[s] = n;
    while (top) { const i = stack[--top], x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * h - w ? i + w : -1])
        if (j >= 0 && mask[j] && !label[j]) { label[j] = n; stack[top++] = j; } }
  }
  return { label, count: n };
}

/**
 * @param {ImageData} current  current UV map (workbench orientation)
 * @param {ImageData} ai       AI-refined atlas, already resized to the same size and orientation
 * @param {Uint8Array} coverage 1 where a UV triangle owns the texel
 * @param {object} o
 * @param {number} o.strength  how much AI detail to add (0–2)
 * @param {number} o.radius    detail scale in texels; larger keeps bigger shapes (and more drift)
 * @param {number} o.flatSkip  islands whose current-map detail is below this are left untouched
 * @param {'color'|'normal'} o.channel
 * @returns {{data: ImageData, kept: number, skipped: number, islands: number}}
 */
export function mergeDetail(current, ai, coverage, { strength = 1, radius = 6, flatSkip = 2.2, channel = 'color' } = {}) {
  const w = current.width, h = current.height, n = w * h, c = current.data, a = ai.data;
  const out = new ImageData(new Uint8ClampedArray(c), w, h), o = out.data;
  // Shrink coverage by a couple of texels: AI drift is worst right at island borders and seams.
  const inner = new Uint8Array(n);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { const i = y * w + x; if (coverage[i] && coverage[i - 2] && coverage[i + 2] && coverage[i - 2 * w] && coverage[i + 2 * w]) inner[i] = 1; }
  const { label, count } = islands(coverage, w, h);
  // Per-island current detail (std of high-pass luminance): flat islands are skipped.
  const lum = (d, i) => .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2];
  const cl = new Float32Array(n); for (let i = 0; i < n; i++) cl[i] = lum(c, i);
  const cb = blur(cl, w, h, radius);
  const sum = new Float64Array(count + 1), sq = new Float64Array(count + 1), cnt = new Uint32Array(count + 1);
  for (let i = 0; i < n; i++) { const k = label[i]; if (!k) continue; const v = cl[i] - cb[i]; sum[k] += v; sq[k] += v * v; cnt[k]++; }
  const skip = new Uint8Array(count + 1); let skipped = 0;
  for (let k = 1; k <= count; k++) { const m = sum[k] / cnt[k], sd = Math.sqrt(Math.max(0, sq[k] / cnt[k] - m * m)); if (cnt[k] > 64 && sd < flatSkip) { skip[k] = 1; skipped++; } }
  // Ease the detail in from island borders so seams stay continuous.
  const fade = blur(Float32Array.from(inner), w, h, 2);
  // Detail only goes where the current map already has texture: flat paint (floors, caps) stays flat
  // even inside an island that was not skipped as a whole.
  const hp = new Float32Array(n); for (let i = 0; i < n; i++) hp[i] = Math.abs(cl[i] - cb[i]);
  const local = blur(hp, w, h, radius * 2);
  for (let i = 0; i < n; i++) fade[i] *= Math.min(1, Math.max(0, (local[i] - 1.5) / 6));
  for (let ch = 0; ch < 3; ch++) {
    const src = new Float32Array(n); for (let i = 0; i < n; i++) src[i] = a[i * 4 + ch];
    const low = blur(src, w, h, radius);
    for (let i = 0; i < n; i++) {
      if (!inner[i] || skip[label[i]]) continue;
      let d = (src[i] - low[i]) * strength * fade[i];
      // Colour detail: limit so a misplaced AI stroke cannot paint a strong new edge.
      if (channel === 'color') d = Math.max(-48, Math.min(48, d));
      o[i * 4 + ch] = c[i * 4 + ch] + d;
    }
  }
  if (channel === 'normal') {
    // Re-normalise tangent normals after adding detail.
    for (let i = 0; i < n; i++) { if (!inner[i] || skip[label[i]]) continue; const p = i * 4;
      let x = o[p] / 127.5 - 1, y = o[p + 1] / 127.5 - 1, z = Math.max(.05, o[p + 2] / 127.5 - 1); const l = Math.hypot(x, y, z) || 1;
      o[p] = (x / l + 1) * 127.5; o[p + 1] = (y / l + 1) * 127.5; o[p + 2] = (z / l + 1) * 127.5; }
  }
  return { data: out, kept: count - skipped, skipped, islands: count };
}
