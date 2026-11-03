// Removes the flat background that image models copy from the grey generation snapshot,
// so projection never paints that grey onto the mesh edges.
//
// Background = pixels connected to the image border whose colour stays close to the
// border's median colour. The mesh silhouette from the snapshot (shrunk inwards) is
// protected, so grey or silver surfaces inside the model are never removed.

const loadImage = url => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('无法读取图片，抠图失败。'));
  image.src = url;
});

function pixelsOf(image, width, height) {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error(`浏览器无法创建 ${width}×${height} 画布（内存不足），抠图失败。`);
  ctx.drawImage(image, 0, 0, width, height);
  return { canvas, ctx, data: ctx.getImageData(0, 0, width, height) };
}

// Median of the outer ring: robust against the subject touching one edge.
function borderColor(d, w, h, ring) {
  const r = [], g = [], b = [];
  const take = i => { r.push(d[i]); g.push(d[i + 1]); b.push(d[i + 2]); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= ring && x < w - ring && y >= ring && y < h - ring) { x = w - ring - 1; continue; }
    if ((x + y) % 3 === 0) take((y * w + x) * 4);
  }
  const mid = a => a.sort((p, q) => p - q)[a.length >> 1];
  return [mid(r), mid(g), mid(b)];
}

// Separable box erosion of a 0/1 mask (min filter), radius in pixels.
function erode(mask, w, h, radius) {
  if (radius <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) { run = mask[y * w + x] ? run + 1 : 0; tmp[y * w + x] = run; }
  }
  // tmp holds left-run lengths; a pixel survives horizontally if a run of 2r+1 is centred on it.
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const right = Math.min(w - 1, x + radius);
    horiz[y * w + x] = x - radius >= 0 && tmp[y * w + right] >= right - (x - radius) + 1 ? 1 : 0;
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < h; y++) { run = horiz[y * w + x] ? run + 1 : 0; tmp[y * w + x] = run; }
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    const bottom = Math.min(h - 1, y + radius);
    out[y * w + x] = y - radius >= 0 && tmp[bottom * w + x] >= bottom - (y - radius) + 1 ? 1 : 0;
  }
  return out;
}

// Two box-blur passes turn the hard keep mask into a soft alpha edge.
function feather(mask, w, h, radius) {
  let src = Float32Array.from(mask), dst = new Float32Array(w * h);
  const blur = (from, to, horizontal) => {
    const n = horizontal ? w : h, lines = horizontal ? h : w, span = 2 * radius + 1;
    for (let l = 0; l < lines; l++) {
      const at = i => horizontal ? l * w + i : i * w + l;
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += from[at(Math.min(n - 1, Math.max(0, i)))];
      for (let i = 0; i < n; i++) {
        to[at(i)] = sum / span;
        sum += from[at(Math.min(n - 1, i + radius + 1))] - from[at(Math.max(0, i - radius))];
      }
    }
  };
  for (let pass = 0; pass < 2; pass++) { blur(src, dst, true); blur(dst, src, false); }
  return src;
}

/**
 * @param {string} imageUrl generated image (any format)
 * @param {object} options
 * @param {string} [options.maskUrl] snapshot silhouette PNG (alpha > 0 = mesh)
 * @param {number} [options.tolerance] max per-channel distance to the background colour (0–255)
 * @param {number} [options.protect] how far inside the silhouette is always kept, as a fraction of image width
 * @returns {Promise<{url:string,width:number,height:number,removed:number,background:number[]}>}
 */
export async function matteImage(imageUrl, { maskUrl = null, tolerance = 22, protect = 0.012 } = {}) {
  const image = await loadImage(imageUrl);
  const w = image.naturalWidth, h = image.naturalHeight, n = w * h;
  const { canvas, ctx, data } = pixelsOf(image, w, h), d = data.data;
  const bg = borderColor(d, w, h, Math.max(4, Math.round(w / 256)));

  let core = null, inside = null;
  if (maskUrl) {
    const mask = await loadImage(maskUrl), md = pixelsOf(mask, w, h).data.data;
    inside = new Uint8Array(n);
    for (let i = 0; i < n; i++) inside[i] = md[i * 4 + 3] > 127 ? 1 : 0;
    core = erode(inside, w, h, Math.max(2, Math.round(w * protect)));
  }

  const isBackground = i => {
    const p = i * 4;
    return Math.abs(d[p] - bg[0]) <= tolerance && Math.abs(d[p + 1] - bg[1]) <= tolerance && Math.abs(d[p + 2] - bg[2]) <= tolerance && !(core && core[i]);
  };
  // Flood fill from every border pixel.
  const removed = new Uint8Array(n), queue = new Int32Array(n);
  let head = 0, tail = 0;
  const push = i => { if (!removed[i] && isBackground(i)) { removed[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  // Gaps enclosed by handles or pipes never touch the border; seed them from outside the mesh silhouette.
  if (inside) for (let i = 0; i < n; i++) if (!inside[i]) push(i);
  while (head < tail) {
    const i = queue[head++], x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }

  const keep = new Uint8Array(n);
  let removedCount = 0;
  for (let i = 0; i < n; i++) { keep[i] = removed[i] ? 0 : 1; removedCount += removed[i]; }
  const alpha = feather(keep, w, h, Math.max(1, Math.round(w / 1024)));
  for (let i = 0; i < n; i++) {
    // Feathering may only soften the kept edge, never bring removed background back.
    const a = keep[i] ? alpha[i] : 0;
    d[i * 4 + 3] = Math.round(a * 255);
  }
  ctx.putImageData(data, 0, 0);
  const url = canvas.toDataURL('image/png');
  canvas.width = canvas.height = 0;
  return { url, width: w, height: h, removed: removedCount / n, background: bg };
}

/**
 * Removes lighting the image model painted into an albedo: soft-clips specular highlights,
 * lifts crushed shadows, and evens out large-scale shading while keeping colour and detail.
 * Only pixels with alpha > 0 are touched.
 */
export async function delightImage(imageUrl, { strength = 0.6 } = {}) {
  const image = await loadImage(imageUrl);
  const w = image.naturalWidth, h = image.naturalHeight, n = w * h;
  const { canvas, ctx, data } = pixelsOf(image, w, h), d = data.data;
  // Large-scale luminance (shading) via downsample → blur → upsample.
  const S = 128, small = Object.assign(document.createElement('canvas'), { width: S, height: S }), sx = small.getContext('2d', { willReadFrequently: true });
  sx.filter = 'blur(6px)'; sx.drawImage(canvas, 0, 0, S, S);
  const sd = sx.getImageData(0, 0, S, S).data;
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] > 0) { sum += .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2]; cnt++; }
  const mean = cnt ? sum / cnt : 128, knee = 205;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4; if (!d[p + 3]) continue;
    const r = d[p], g = d[p + 1], b = d[p + 2], L = .299 * r + .587 * g + .114 * b || 1;
    const q = (Math.min(S - 1, Math.floor(y / h * S)) * S + Math.min(S - 1, Math.floor(x / w * S))) * 4;
    const local = .299 * sd[q] + .587 * sd[q + 1] + .114 * sd[q + 2] || mean;
    // Flatten broad shading toward the image mean, then compress highlights and lift deep darks.
    let target = L * Math.pow(mean / local, strength * .6);
    if (target > knee) target = knee + (target - knee) * (1 - strength * .75);
    if (target < 28) target = target + (28 - target) * strength * .6;
    const k = Math.max(0, Math.min(3, target / L));
    d[p] = Math.min(255, r * k); d[p + 1] = Math.min(255, g * k); d[p + 2] = Math.min(255, b * k);
  }
  ctx.putImageData(data, 0, 0);
  const url = canvas.toDataURL('image/png'); canvas.width = canvas.height = 0; small.width = small.height = 0;
  return { url };
}

/**
 * Cleans an AI emission image: keeps only bright pixels (soft threshold on the brightest channel,
 * so saturated red/blue glows survive) and reports how much of the mesh silhouette is dark.
 * A real emission map is dark almost everywhere on the mesh; a low darkShare means the model
 * painted ordinary colours instead.
 */
export async function emissiveFilter(imageUrl, { maskUrl = null, low = 0.14, high = 0.34 } = {}) {
  const image = await loadImage(imageUrl);
  const w = image.naturalWidth, h = image.naturalHeight, n = w * h;
  const { canvas, ctx, data } = pixelsOf(image, w, h), d = data.data;
  let inside = null;
  if (maskUrl) { const mask = await loadImage(maskUrl), md = pixelsOf(mask, w, h).data.data; inside = new Uint8Array(n); for (let i = 0; i < n; i++) inside[i] = md[i * 4 + 3] > 127 ? 1 : 0; }
  let total = 0, dark = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = Math.max(d[p], d[p + 1], d[p + 2]) / 255;
    if (!inside || inside[i]) { total++; if (v < low) dark++; }
    const t = Math.min(1, Math.max(0, (v - low) / (high - low))), k = t * t * (3 - 2 * t);
    d[p] *= k; d[p + 1] *= k; d[p + 2] *= k;
  }
  ctx.putImageData(data, 0, 0);
  const url = canvas.toDataURL('image/png'); canvas.width = canvas.height = 0;
  return { url, darkShare: total ? dark / total : 1 };
}
