import * as THREE from 'three';
import { dilate } from './transfer-bake.js';

// Shape-driven shading for the colour map. AI paints detail without knowing where the surface
// bulges or sinks, so carved models look like flat camouflage. Curvature comes from the mesh
// itself (big forms) and from the normal map (fine sculpt detail), so it always sits exactly on
// the structure: grooves get darker, ridges get a worn-metal highlight.

/** Mean curvature per vertex, positive on convex ridges, negative in grooves, normalised to about [-1, 1]. */
export function vertexCurvature(geometry) {
  const pos = geometry.attributes.position, nrm = geometry.attributes.normal, idx = geometry.index;
  if (!nrm) geometry.computeVertexNormals();
  const normal = geometry.attributes.normal, n = pos.count;
  const box = new THREE.Box3().setFromBufferAttribute(pos), q = 2e4 / Math.max(1e-6, box.getSize(new THREE.Vector3()).length());
  // UV seams split vertices; merge by position so curvature is continuous across seams.
  const ids = new Map(), slot = new Int32Array(n);
  for (let i = 0; i < n; i++) { const k = `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`; let id = ids.get(k); if (id === undefined) ids.set(k, id = ids.size); slot[i] = id; }
  const m = ids.size, P = new Float32Array(m * 3), N = new Float32Array(m * 3);
  for (let i = 0; i < n; i++) { const s = slot[i] * 3; P[s] = pos.getX(i); P[s + 1] = pos.getY(i); P[s + 2] = pos.getZ(i); N[s] += normal.getX(i); N[s + 1] += normal.getY(i); N[s + 2] += normal.getZ(i); }
  for (let s = 0; s < m * 3; s += 3) { const l = Math.hypot(N[s], N[s + 1], N[s + 2]) || 1; N[s] /= l; N[s + 1] /= l; N[s + 2] /= l; }
  const K = new Float32Array(m), C = new Uint16Array(m), nb = [];
  const edge = (a, b) => {
    const dx = P[b * 3] - P[a * 3], dy = P[b * 3 + 1] - P[a * 3 + 1], dz = P[b * 3 + 2] - P[a * 3 + 2], l2 = dx * dx + dy * dy + dz * dz;
    if (l2 < 1e-14) return;
    // Normals spreading apart along an edge = convex; converging = concave.
    K[a] += ((N[b * 3] - N[a * 3]) * dx + (N[b * 3 + 1] - N[a * 3 + 1]) * dy + (N[b * 3 + 2] - N[a * 3 + 2]) * dz) / l2; C[a]++;
    nb.push(a, b);
  };
  const tri = idx ? idx.count : n;
  for (let t = 0; t < tri; t += 3) {
    const a = slot[idx ? idx.getX(t) : t], b = slot[idx ? idx.getX(t + 1) : t + 1], c = slot[idx ? idx.getX(t + 2) : t + 2];
    edge(a, b); edge(b, a); edge(b, c); edge(c, b); edge(c, a); edge(a, c);
  }
  for (let i = 0; i < m; i++) if (C[i]) K[i] /= C[i];
  // One smoothing pass removes triangle noise without losing carved forms.
  const S = new Float32Array(m), SC = new Uint16Array(m);
  for (let e = 0; e < nb.length; e += 2) { S[nb[e]] += K[nb[e + 1]]; SC[nb[e]]++; }
  for (let i = 0; i < m; i++) K[i] = SC[i] ? K[i] * .5 + S[i] / SC[i] * .5 : K[i];
  const abs = Float32Array.from(K, Math.abs).sort(), scale = abs[Math.floor(abs.length * .95)] || 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, K[slot[i]] / scale));
  return out;
}

const vertexShader = `attribute float curv; varying float vC; void main(){ vC = curv; gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }`;
const fragmentShader = `varying float vC; void main(){ gl_FragColor = vec4(vC * 0.5 + 0.5, 0.0, 0.0, 1.0); }`;

/** Rasterise per-vertex curvature into UV space. Returns curvature in [-1, 1] per texel (workbench row order) and a coverage mask. */
export function bakeVertexCurvature({ renderer, mesh, materialIndex = 0, size = 2048 }) {
  const g = mesh.geometry;
  if (!g.attributes.uv) throw new Error('模型没有 UV。');
  const curv = mesh.userData.workbenchCurvature ||= vertexCurvature(g);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', g.attributes.position); geo.setAttribute('uv', g.attributes.uv); geo.setAttribute('curv', new THREE.BufferAttribute(curv, 1));
  if (g.index) geo.setIndex(g.index);
  if (g.groups.length) g.groups.filter(gr => gr.materialIndex === materialIndex).forEach(gr => geo.addGroup(gr.start, gr.count, 0));
  const mat = new THREE.ShaderMaterial({ vertexShader, fragmentShader, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(geo, geo.groups.length ? [mat] : mat));
  const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, generateMipmaps: false });
  const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  const px = new Uint8ClampedArray(size * size * 4);
  try {
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, new Uint8Array(px.buffer));
  } finally { renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha); rt.dispose(); mat.dispose(); geo.dispose(); }
  const stride = size * 4, row = new Uint8ClampedArray(stride);
  for (let a = 0, b = size - 1; a < b; a++, b--) { row.set(px.subarray(a * stride, a * stride + stride)); px.copyWithin(a * stride, b * stride, b * stride + stride); px.set(row, b * stride); }
  const cover = new Uint8Array(size * size); for (let i = 0; i < cover.length; i++) cover[i] = px[i * 4 + 3] > 0 ? 1 : 0;
  dilate(px, size, Math.max(4, Math.round(size / 512)));
  const out = new Float32Array(size * size); for (let i = 0; i < out.length; i++) out[i] = px[i * 4] / 127.5 - 1;
  return { curvature: out, coverage: cover };
}

/** Fine curvature from a tangent-space normal map (OpenGL, workbench row order): divergence of the normal's xy. */
export function normalMapCurvature(imageData) {
  const { width: w, height: h, data: d } = imageData, out = new Float32Array(w * h);
  const nx = i => d[i * 4] / 127.5 - 1, ny = i => d[i * 4 + 1] / 127.5 - 1;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    // Rows run top-down while +v (green) points up, so the v-derivative flips sign.
    out[i] = (nx(i + 1) - nx(i - 1)) * .5 - (ny(i + w) - ny(i - w)) * .5;
  }
  const abs = Float32Array.from(out.filter((_, i) => i % 7 === 0), Math.abs).sort(), scale = abs[Math.floor(abs.length * .97)] || 1;
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] / scale));
  return out;
}

/**
 * Packs shading into a canvas: R = colour multiplier (255 = unchanged, darker = cavity),
 * G = ridge highlight amount. Re-run cheaply when the sliders move.
 */
export function buildShadeCanvas({ size, curvature, ao, cavity = .65, edge = .5 }) {
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size }), ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size), p = img.data;
  for (let i = 0, q = 0; i < size * size; i++, q += 4) {
    const k = curvature[i], a = ao ? ao[i] / 255 : 1;
    // AO contrast is stretched (raw AO is mostly 0.7–1.0); grooves add their own darkening.
    const occ = Math.min(1, Math.max(0, (1 - a) * 1.8));
    const mul = (1 - cavity * .85 * occ) * (1 - cavity * .6 * Math.max(0, -k));
    p[q] = Math.max(0, Math.min(255, mul * 255));
    // Ridges only highlight where they are exposed (not deep in a cavity), like real edge wear.
    p[q + 1] = Math.max(0, Math.min(255, edge * Math.pow(Math.max(0, k), .7) * 1.6 * (1 - occ) * 255));
    p[q + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Applies a shade canvas onto a composed colour canvas in place. */
export function applyShade(ctx, shadeCanvas, size, opacity = 1) {
  const s = Object.assign(document.createElement('canvas'), { width: size, height: size }), sx = s.getContext('2d');
  sx.drawImage(shadeCanvas, 0, 0, size, size);
  const sh = sx.getImageData(0, 0, size, size).data, base = ctx.getImageData(0, 0, size, size), b = base.data;
  for (let q = 0; q < b.length; q += 4) {
    const mul = 1 - (1 - sh[q] / 255) * opacity, hi = sh[q + 1] / 255 * opacity * .7;
    for (let c = 0; c < 3; c++) { let v = b[q + c] * mul; v += (228 - v) * hi; b[q + c] = v; }
  }
  ctx.putImageData(base, 0, 0); s.width = s.height = 0;
}
