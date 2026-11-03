// Image models do not paint physically valid view-space normals (measured: a front-facing chest
// came back tilted ~60°). Their fine relief is still useful, so keep only the high-frequency part:
// detail = image − blur(image), encoded as a tangent-style normal around +Z. Projected in "tangent"
// mode it perturbs the mesh's real normal instead of replacing it.

const loadImage = url => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('无法读取法线图片。'));
  image.src = url;
});

function boxBlur(src, w, h, radius) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), span = 2 * radius + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0; const row = y * w;
    for (let i = -radius; i <= radius; i++) sum += src[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / span;
      sum += src[row + Math.min(w - 1, x + radius + 1)] - src[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / span;
      sum += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}
const blur = (src, w, h, r) => boxBlur(boxBlur(src, w, h, r), w, h, r);

/**
 * @param {string} imageUrl AI "normal" image aligned with the snapshot
 * @param {object} options
 * @param {string} [options.maskUrl] snapshot silhouette (alpha > 0 = mesh); outside becomes transparent
 * @param {number} [options.radius] detail scale as a fraction of image width; larger keeps bigger bumps
 * @param {number} [options.strength] multiplier on the detail slope
 * @param {number} [options.workSize] processing resolution (the result is this size)
 */
export async function detailNormal(imageUrl, { maskUrl = null, radius = 0.006, strength = 2.2, workSize = 4096 } = {}) {
  const image = await loadImage(imageUrl);
  const w = Math.min(workSize, image.naturalWidth), h = Math.round(w * image.naturalHeight / image.naturalWidth), n = w * h;
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器无法创建法线画布（内存不足）。');
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h), d = data.data;

  let inside = null;
  if (maskUrl) {
    const mask = await loadImage(maskUrl), mc = Object.assign(document.createElement('canvas'), { width: w, height: h }), mx = mc.getContext('2d');
    mx.drawImage(mask, 0, 0, w, h); const md = mx.getImageData(0, 0, w, h).data;
    inside = new Uint8Array(n); for (let i = 0; i < n; i++) inside[i] = md[i * 4 + 3] > 127 ? 1 : 0;
    mc.width = mc.height = 0;
  }
  // Use the colour-independent slope: luminance as height, plus the red/green channels the model
  // intended as x/y slope. Both are high-passed, so global tint and shading cancel out.
  const lum = new Float32Array(n), red = new Float32Array(n), green = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) { red[i] = d[p]; green[i] = d[p + 1]; lum[i] = .299 * d[p] + .587 * d[p + 1] + .114 * d[p + 2]; }
  const r = Math.max(2, Math.round(w * radius));
  const lb = blur(lum, w, h, r), rb = blur(red, w, h, r), gb = blur(green, w, h, r);
  const hp = new Float32Array(n);
  for (let i = 0; i < n; i++) hp[i] = lum[i] - lb[i];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, p = i * 4;
    if (inside && !inside[i]) { d[p] = 128; d[p + 1] = 128; d[p + 2] = 255; d[p + 3] = 0; continue; }
    // Height gradient (central difference) of the high-passed luminance.
    const gx = (hp[y * w + Math.min(w - 1, x + 1)] - hp[y * w + Math.max(0, x - 1)]) / 255;
    const gy = (hp[Math.max(0, y - 1) * w + x] - hp[Math.min(h - 1, y + 1) * w + x]) / 255;
    let nx = (-gx * 6 + (red[i] - rb[i]) / 127.5) * strength;
    let ny = (-gy * 6 + (green[i] - gb[i]) / 127.5) * strength;
    const len = Math.hypot(nx, ny, 1);
    d[p] = Math.round((nx / len + 1) * 127.5); d[p + 1] = Math.round((ny / len + 1) * 127.5); d[p + 2] = Math.round((1 / len + 1) * 127.5); d[p + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  const url = canvas.toDataURL('image/png');
  canvas.width = canvas.height = 0;
  return { url, width: w, height: h };
}
