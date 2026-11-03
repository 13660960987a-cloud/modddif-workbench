import * as THREE from 'three';

// Re-bakes textures from a source model onto a target model that has the SAME triangles but a
// different UV layout (Tripo Smart UV keeps geometry, re-unwraps, and drops maps to 2K; the
// generation output still has 4K–8K maps on its own UVs).
//
// Triangles are matched by their quantised corner positions, so every target texel reads the
// exact source surface point: no ray casting, no approximation. Normal maps are re-expressed in
// the target tangent frame (source TBN → object space → target TBN).

const vertexShader = `
attribute vec2 srcUV;
attribute vec3 srcN;
attribute vec4 srcT;
attribute vec4 dstT;
varying vec2 vSrcUV;
varying vec3 vSrcN;
varying vec4 vSrcT;
varying vec3 vDstN;
varying vec4 vDstT;
void main() {
  vSrcUV = srcUV; vSrcN = srcN; vSrcT = srcT; vDstN = normal; vDstT = dstT;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const fragmentShader = `
uniform sampler2D map;
uniform bool normalMode;
varying vec2 vSrcUV;
varying vec3 vSrcN;
varying vec4 vSrcT;
varying vec3 vDstN;
varying vec4 vDstT;
void main() {
  vec4 c = texture2D(map, vSrcUV);
  if (normalMode) {
    vec3 Ns = normalize(vSrcN), Ts = normalize(vSrcT.xyz - Ns * dot(vSrcT.xyz, Ns)), Bs = cross(Ns, Ts) * vSrcT.w;
    vec3 Nd = normalize(vDstN), Td = normalize(vDstT.xyz - Nd * dot(vDstT.xyz, Nd)), Bd = cross(Nd, Td) * vDstT.w;
    vec3 t = c.rgb * 2.0 - 1.0;
    vec3 n = normalize(Ts * t.x + Bs * t.y + Ns * t.z);
    c.rgb = normalize(vec3(dot(n, Td), dot(n, Bd), dot(n, Nd))) * 0.5 + 0.5;
  }
  gl_FragColor = vec4(c.rgb, 1.0);
}`;

const keyOf = (pos, i, q) => `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;

function withTangents(geometry) {
  const g = geometry.clone();
  if (!g.index) { const idx = []; for (let i = 0; i < g.attributes.position.count; i++) idx.push(i); g.setIndex(idx); }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.tangent) g.computeTangents();
  return g;
}

/** Builds a non-indexed target geometry carrying, per corner, the matched source UV and frames. */
function matchGeometry(targetGeometry, sourceGeometry) {
  const tg = withTangents(targetGeometry), sg = withTangents(sourceGeometry);
  const box = new THREE.Box3().setFromBufferAttribute(sg.attributes.position);
  const q = 2e4 / Math.max(1e-6, box.getSize(new THREE.Vector3()).length());
  const sp = sg.attributes.position, sIdx = sg.index, tp = tg.attributes.position, tIdx = tg.index;
  const sourceTris = new Map();
  for (let t = 0; t < sIdx.count / 3; t++) {
    const corners = [0, 1, 2].map(k => sIdx.getX(t * 3 + k));
    const keys = corners.map(v => keyOf(sp, v, q));
    sourceTris.set([...keys].sort().join('|'), { corners, keys });
  }
  const triCount = tIdx.count / 3, n = triCount * 3;
  const out = { position: new Float32Array(n * 3), uv: new Float32Array(n * 2), normal: new Float32Array(n * 3), dstT: new Float32Array(n * 4), srcUV: new Float32Array(n * 2), srcN: new Float32Array(n * 3), srcT: new Float32Array(n * 4) };
  const A = (name, g) => g.attributes[name];
  let matched = 0, w = 0;
  for (let t = 0; t < triCount; t++) {
    const corners = [0, 1, 2].map(k => tIdx.getX(t * 3 + k)), keys = corners.map(v => keyOf(tp, v, q));
    const hit = sourceTris.get([...keys].sort().join('|'));
    if (!hit) continue;
    matched++;
    for (let k = 0; k < 3; k++) {
      const dv = corners[k], sv = hit.corners[hit.keys.indexOf(keys[k])];
      out.position.set([tp.getX(dv), tp.getY(dv), tp.getZ(dv)], w * 3);
      out.uv.set([A('uv', tg).getX(dv), A('uv', tg).getY(dv)], w * 2);
      out.normal.set([A('normal', tg).getX(dv), A('normal', tg).getY(dv), A('normal', tg).getZ(dv)], w * 3);
      out.dstT.set([A('tangent', tg).getX(dv), A('tangent', tg).getY(dv), A('tangent', tg).getZ(dv), A('tangent', tg).getW(dv)], w * 4);
      out.srcUV.set([A('uv', sg).getX(sv), A('uv', sg).getY(sv)], w * 2);
      out.srcN.set([A('normal', sg).getX(sv), A('normal', sg).getY(sv), A('normal', sg).getZ(sv)], w * 3);
      out.srcT.set([A('tangent', sg).getX(sv), A('tangent', sg).getY(sv), A('tangent', sg).getZ(sv), A('tangent', sg).getW(sv)], w * 4);
      w++;
    }
  }
  tg.dispose(); sg.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(out.position.subarray(0, w * 3), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(out.uv.subarray(0, w * 2), 2));
  geometry.setAttribute('normal', new THREE.BufferAttribute(out.normal.subarray(0, w * 3), 3));
  geometry.setAttribute('dstT', new THREE.BufferAttribute(out.dstT.subarray(0, w * 4), 4));
  geometry.setAttribute('srcUV', new THREE.BufferAttribute(out.srcUV.subarray(0, w * 2), 2));
  geometry.setAttribute('srcN', new THREE.BufferAttribute(out.srcN.subarray(0, w * 3), 3));
  geometry.setAttribute('srcT', new THREE.BufferAttribute(out.srcT.subarray(0, w * 4), 4));
  return { geometry, matched, total: triCount };
}

// Fills empty texels from their neighbours so mip-mapping and bilinear filtering never pull in black at UV seams.
export function dilate(pixels, size, passes) {
  const alpha = new Uint8Array(size * size);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3] > 0 ? 1 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const next = alpha.slice();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x; if (alpha[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx; if (!alpha[j]) continue;
        r += pixels[j * 4]; g += pixels[j * 4 + 1]; b += pixels[j * 4 + 2]; n++;
      }
      if (n) { pixels[i * 4] = r / n; pixels[i * 4 + 1] = g / n; pixels[i * 4 + 2] = b / n; pixels[i * 4 + 3] = 255; next[i] = 1; }
    }
    alpha.set(next);
  }
}

/**
 * @param {object} o
 * @param {THREE.WebGLRenderer} o.renderer
 * @param {THREE.BufferGeometry} o.target  geometry with the new UVs
 * @param {THREE.BufferGeometry} o.source  geometry with the original UVs (same triangles, same local space)
 * @param {{name:string, texture:THREE.Texture, normal?:boolean}[]} o.maps
 * @param {number} [o.size]
 * @returns {Promise<{canvases:Record<string,HTMLCanvasElement>, matched:number, total:number}>}
 */
export async function transferBake({ renderer, target, source, maps, size = 4096 }) {
  if (!target.attributes.uv || !source.attributes.uv) throw new Error('原模型或新模型没有 UV，无法转烘焙。');
  const { geometry, matched, total } = matchGeometry(target, source);
  if (matched < total * 0.9) { geometry.dispose(); throw new Error(`两个模型只有 ${Math.round(matched / total * 100)}% 的三角形一致，不是同一个网格，无法转烘焙。`); }
  const material = new THREE.ShaderMaterial({ uniforms: { map: { value: null }, normalMode: { value: false } }, vertexShader, fragmentShader, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(geometry, material));
  const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
  const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  const canvases = {};
  try {
    for (const m of maps) {
      // Read raw bytes: an sRGB texture would otherwise be decoded to linear on sample and stored too dark.
      const texture = m.texture.clone(); texture.colorSpace = THREE.NoColorSpace; texture.needsUpdate = true;
      material.uniforms.map.value = texture; material.uniforms.normalMode.value = !!m.normal;
      renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
      const data = new ImageData(size, size);
      renderer.readRenderTargetPixels(rt, 0, 0, size, size, new Uint8Array(data.data.buffer));
      texture.dispose();
      // Render-target rows are bottom-up; workbench canvases put v=1 on the first row.
      const stride = size * 4, row = new Uint8ClampedArray(stride), px = data.data;
      for (let a = 0, b = size - 1; a < b; a++, b--) { row.set(px.subarray(a * stride, a * stride + stride)); px.copyWithin(a * stride, b * stride, b * stride + stride); px.set(row, b * stride); }
      dilate(px, size, Math.max(4, Math.round(size / 512)));
      const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
      canvas.getContext('2d').putImageData(data, 0, 0);
      canvases[m.name] = canvas;
      await new Promise(r => setTimeout(r));
    }
  } finally {
    renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha);
    rt.dispose(); material.dispose(); geometry.dispose();
  }
  return { canvases, matched, total };
}
