import * as THREE from 'three';
import { worldGeometry } from './texture-engine.js';
import { dilate } from './transfer-bake.js';

// Ambient occlusion baked into UV space: render a depth map from many directions around the
// model, and for each texel count how many directions see it. Cavities between scales and fins
// are seen from few directions and come out dark.

const vertexShader = `
varying vec3 vPos;
varying vec3 vNormal;
void main() { vPos = position; vNormal = normal; gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }`;

const fragmentShader = `
uniform sampler2D depthMap;
uniform mat4 viewProj;
uniform vec3 dir;
uniform float bias;
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  float facing = dot(n, dir);
  if (facing <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec4 p = viewProj * vec4(vPos + n * bias, 1.0);
  vec3 ndc = p.xyz / p.w;
  float visible = texture2D(depthMap, ndc.xy * 0.5 + 0.5).r >= ndc.z * 0.5 + 0.5 - 0.0004 ? 1.0 : 0.0;
  // Cosine weighting: directions near the surface normal matter most, as for diffuse light.
  gl_FragColor = vec4(visible * facing, facing, 0.0, 1.0);
}`;

// Even spread of directions over the sphere (Fibonacci lattice).
function directions(count) {
  const out = [], golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i + .5) / count * 2, r = Math.sqrt(1 - y * y), a = i * golden;
    out.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return out;
}

/**
 * @returns {Promise<Map<string, HTMLCanvasElement>>} AO per `${mesh.uuid}:${materialIndex}` (white = open, dark = occluded)
 */
export async function bakeAO({ renderer, meshes, size = 4096, samples = 96, strength = 1, onProgress = () => {} }) {
  const pairs = meshes.filter(m => m.isMesh).map(mesh => ({ mesh, geometry: worldGeometry(mesh) }));
  const receivers = pairs.filter(p => !p.geometry.userData.noUV);
  if (!receivers.length) throw new Error('模型没有 UV，无法烘焙 AO。');
  const box = new THREE.Box3(); pairs.forEach(p => { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); });
  const center = box.getCenter(new THREE.Vector3()), radius = box.getSize(new THREE.Vector3()).length() / 2;

  const depthSize = 2048;
  const depthTarget = new THREE.WebGLRenderTarget(depthSize, depthSize, { depthBuffer: true });
  depthTarget.depthTexture = new THREE.DepthTexture(depthSize, depthSize, THREE.UnsignedIntType);
  const depthMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false });
  const depthScene = new THREE.Scene(); pairs.forEach(p => depthScene.add(new THREE.Mesh(p.geometry, depthMaterial)));

  const shader = new THREE.ShaderMaterial({
    uniforms: { depthMap: { value: depthTarget.depthTexture }, viewProj: { value: new THREE.Matrix4() }, dir: { value: new THREE.Vector3() }, bias: { value: radius * .0015 } },
    vertexShader, fragmentShader, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    transparent: true, blending: THREE.AdditiveBlending,
  });
  // Float accumulation keeps 96 small additions precise.
  const accTarget = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, depthBuffer: false, generateMipmaps: false });
  const camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, radius * .1, radius * 4);
  const flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  const results = new Map();
  try {
    for (const { mesh, geometry } of receivers) {
      const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: geometry.index ? geometry.index.count : geometry.attributes.position.count, materialIndex: 0 }];
      for (const group of groups) {
        const piece = geometry.clone(); piece.clearGroups(); piece.addGroup(group.start, group.count, 0);
        const uvScene = new THREE.Scene(); uvScene.add(new THREE.Mesh(piece, [shader]));
        renderer.setRenderTarget(accTarget); renderer.setClearColor(0x000000, 0); renderer.clear();
        const dirs = directions(samples);
        for (let i = 0; i < dirs.length; i++) {
          const d = dirs[i];
          camera.position.copy(center).addScaledVector(d, radius * 2); camera.up.set(Math.abs(d.y) > .99 ? 1 : 0, Math.abs(d.y) > .99 ? 0 : 1, 0);
          camera.lookAt(center); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
          renderer.setRenderTarget(depthTarget); renderer.clear(); renderer.render(depthScene, camera);
          shader.uniforms.viewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
          shader.uniforms.dir.value.copy(d);
          renderer.setRenderTarget(accTarget); renderer.autoClear = false; renderer.render(uvScene, flat); renderer.autoClear = true;
          if (i % 12 === 11) { onProgress((i + 1) / dirs.length); await new Promise(r => setTimeout(r)); }
        }
        const acc = new Float32Array(size * size * 4);
        renderer.readRenderTargetPixels(accTarget, 0, 0, size, size, acc);
        const data = new ImageData(size, size), px = data.data;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const src = ((size - 1 - y) * size + x) * 4, dst = (y * size + x) * 4;
          if (acc[src + 1] <= 0) continue;
          const ao = Math.pow(Math.min(1, acc[src] / acc[src + 1]), strength);
          const v = Math.round(ao * 255); px[dst] = px[dst + 1] = px[dst + 2] = v; px[dst + 3] = 255;
        }
        dilate(px, size, Math.max(4, Math.round(size / 512)));
        const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
        canvas.getContext('2d').putImageData(data, 0, 0);
        results.set(`${mesh.uuid}:${group.materialIndex}`, canvas);
        piece.dispose();
      }
    }
  } finally {
    renderer.autoClear = true; renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha);
    accTarget.dispose(); depthTarget.dispose(); depthMaterial.dispose(); shader.dispose(); pairs.forEach(p => p.geometry.dispose());
  }
  return results;
}
