import * as THREE from 'three';

const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

// Freeze posed vertices in world space so skinned and transformed meshes bake alike.
export function worldGeometry(mesh) {
  const source = mesh.geometry;
  mesh.updateWorldMatrix(true, false);
  mesh.skeleton?.update();
  const positions = new Float32Array(source.attributes.position.count * 3);
  const point = new THREE.Vector3();
  for (let i = 0; i < source.attributes.position.count; i++) {
    mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
    point.toArray(positions, i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // Meshes without UV still occlude in the depth pass; they just cannot receive paint.
  if (source.attributes.uv) geometry.setAttribute('uv', source.attributes.uv.clone()); else geometry.userData.noUV = true;
  if (source.index) geometry.setIndex(source.index.clone());
  source.groups.forEach(group => geometry.addGroup(group.start, group.count, group.materialIndex));
  if (source.attributes.normal && !mesh.isSkinnedMesh) {
    const normals = source.attributes.normal.clone(), nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for(let i=0;i<normals.count;i++){point.fromBufferAttribute(normals,i).applyMatrix3(nm).normalize();normals.setXYZ(i,point.x,point.y,point.z);}
    geometry.setAttribute('normal',normals);
  } else geometry.computeVertexNormals();
  if (source.attributes.tangent && !mesh.isSkinnedMesh) {
    const tangents=source.attributes.tangent.clone();
    for(let i=0;i<tangents.count;i++){point.fromBufferAttribute(tangents,i).transformDirection(mesh.matrixWorld);tangents.setXYZ(i,point.x,point.y,point.z);}
    geometry.setAttribute('tangent',tangents);
  }
  return geometry;
}

const vertexShader = `
attribute vec4 tangent;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUV;
varying vec4 vTangent;
void main() {
  vPosition = position;
  vUV = uv;
  vTangent = tangent;
  vNormal = normal;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;
const fragmentShader = `
uniform mat4 projectMatrix;
uniform sampler2D depthMap;
uniform sampler2D picture;
uniform vec3 eye;
uniform vec3 viewDirection;
uniform bool orthographic;
uniform vec2 fit;
uniform float viewportAspect;
uniform vec2 offset;
uniform float scale;
uniform float angle;
uniform float opacity;
uniform bool normalMode;
uniform bool normalFlipY;
uniform bool viewSpaceNormal;
uniform mat3 cameraRotation;
uniform float fadeStart;
uniform float edgeFeather;
uniform bool clipOn;
uniform vec4 clipPlane;
uniform float fadeEnd;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUV;
varying vec4 vTangent;
void main() {
  vec4 projected = projectMatrix * vec4(vPosition, 1.0);
  if (projected.w <= 0.0) discard;
  // Section cut: the removed half neither receives paint nor blocks it (depth pass is clipped too).
  if (clipOn && dot(clipPlane.xyz, vPosition) + clipPlane.w < 0.0) discard;
  vec3 ndc = projected.xyz / projected.w;
  vec2 screenUV = ndc.xy * 0.5 + 0.5;
  if (screenUV.x < 0.0 || screenUV.x > 1.0 || screenUV.y < 0.0 || screenUV.y > 1.0 || abs(ndc.z) > 1.0) discard;
  float depth = ndc.z * 0.5 + 0.5;
  float visibleDepth = texture2D(depthMap, screenUV).r;
  // Derivative tolerance follows depth precision and steep surfaces.
  float tolerance = max(0.00003, min(0.0005, fwidth(depth) * 1.8));
  if (depth > visibleDepth + tolerance) discard;
  vec3 toEye = orthographic ? -viewDirection : normalize(eye - vPosition);
  float facing = dot(normalize(vNormal), toEye);
  if (facing <= fadeStart) discard;
  vec2 p = (screenUV - vec2(0.5) - offset) * vec2(viewportAspect, 1.0);
  float c = cos(angle), s = sin(angle);
  p = mat2(c, -s, s, c) * p;
  vec2 imageUV = p / (fit * vec2(viewportAspect, 1.0) * max(scale, 0.001)) + vec2(0.5);
  if (imageUV.x < 0.0 || imageUV.x > 1.0 || imageUV.y < 0.0 || imageUV.y > 1.0) discard;
  vec4 color = texture2D(picture, imageUV);
  if (normalMode) {
    vec3 N = normalize(vNormal);
    vec3 px = dFdx(vPosition), py = dFdy(vPosition);
    vec2 ix = dFdx(imageUV), iy = dFdy(imageUV);
    float determinant = ix.x * iy.y - ix.y * iy.x;
    if (abs(determinant) < 1e-12) discard;
    vec3 projectorT = (px * iy.y - py * ix.y) / determinant;
    vec3 projectorB = (-px * iy.x + py * ix.x) / determinant;
    projectorT = normalize(projectorT - N * dot(N, projectorT));
    float projectorSign = dot(cross(N, projectorT), projectorB) < 0.0 ? -1.0 : 1.0;
    projectorB = normalize(cross(N, projectorT)) * projectorSign;
    vec2 ux = dFdx(vUV), uy = dFdy(vUV);
    float ud = ux.x * uy.y - ux.y * uy.x;
    if (abs(ud) < 1e-12) discard;
    vec3 T = (px * uy.y - py * ux.y) / ud;
    vec3 B = (-px * uy.x + py * ux.x) / ud;
    T = normalize(T - N * dot(T, N));
    float uvSign = dot(cross(N, T), B) < 0.0 ? -1.0 : 1.0;
    B = normalize(cross(N, T)) * uvSign;
    if(length(vTangent.xyz)>0.1){T=normalize(vTangent.xyz-N*dot(vTangent.xyz,N)); B=normalize(cross(N,T))*vTangent.w;}
    vec3 incoming = color.rgb * 2.0 - 1.0;
    incoming.xy = (color.rg * 255.0 - 128.0) / 127.0;
    if (normalFlipY) incoming.y *= -1.0;
    vec3 worldNormal = normalize(projectorT * incoming.x + projectorB * incoming.y + N * incoming.z);
    if (viewSpaceNormal) {
      // View-space map encodes right/up/toward-camera in RGB. Image rotation rotates X/Y too.
      float rc = cos(angle), rs = sin(angle);
      incoming.xy = mat2(rc, rs, -rs, rc) * incoming.xy;
      worldNormal = normalize(cameraRotation * incoming);
    }
    vec3 tangentNormal = normalize(vec3(dot(worldNormal, T), dot(worldNormal, B), dot(worldNormal, N)));
    color.rgb = tangentNormal * 0.5 + 0.5;
  }
  // Close-up patches fade out toward the image border so they blend into what is already painted.
  vec2 edge = min(imageUV, 1.0 - imageUV);
  float border = edgeFeather > 0.0 ? smoothstep(0.0, edgeFeather, min(edge.x, edge.y)) : 1.0;
  color.a *= opacity * border * smoothstep(fadeStart, fadeEnd, facing);
  if (color.a < 0.001) discard;
  gl_FragColor = color;
}`;

export function gpuLimits(renderer) {
  const gl = renderer.getContext();
  return { maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), maxViewport: Math.min(...gl.getParameter(gl.MAX_VIEWPORT_DIMS)) };
}
export function checkBakeSize(renderer, size) {
  const limits = gpuLimits(renderer), max = Math.min(limits.maxTextureSize, limits.maxRenderbufferSize, limits.maxViewport);
  if (size > max) throw new Error(`当前显卡最大只能烘焙 ${max}×${max} 贴图，无法使用 ${size}×${size}。`);
}
function assertGPU(renderer, size) {
  const gl = renderer.getContext();
  if (gl.isContextLost()) throw new Error('显卡上下文已丢失（通常是显存不足），请保存工作后刷新页面，并改用较低的 UV 尺寸。');
  const error = gl.getError();
  if (error === gl.OUT_OF_MEMORY) throw new Error(`显存不足，无法完成 ${size}×${size} 烘焙。请关闭其他程序或降低 UV 尺寸。`);
}
function flipRows(pixels, size) {
  const stride = size * 4, row = new Uint8ClampedArray(stride);
  for (let top = 0, bottom = size - 1; top < bottom; top++, bottom--) {
    const a = top * stride, b = bottom * stride;
    row.set(pixels.subarray(a, a + stride)); pixels.copyWithin(a, b, b + stride); pixels.set(row, b);
  }
}

/** Weighted running average of one view's bake into an accumulator (straight alpha = weight). */
export function accumulateView(acc, pixels) {
  const { color, weight } = acc;
  acc.cover ||= new Float32Array(weight.length);
  for (let i = 0, p = 0; i < weight.length; i++, p += 4) {
    const a = pixels[p + 3] / 255; if (!a) continue;
    // Blend weight is facing^4: the most head-on view dominates, so two slightly misaligned
    // AI images do not average into a double (ghosted) edge. Coverage still uses plain facing.
    const w = a * a * a * a;
    const t = w / (weight[i] + w);
    color[p] += (pixels[p] - color[p]) * t; color[p + 1] += (pixels[p + 1] - color[p + 1]) * t; color[p + 2] += (pixels[p + 2] - color[p + 2]) * t;
    weight[i] += w; acc.cover[i] += a;
  }
}
/** Emission merge: brightest view wins, so a glow seen by one view is not averaged away by views that missed it. */
export function accumulateMax(acc, pixels) {
  const { color, weight } = acc;
  acc.cover ||= new Float32Array(weight.length);
  for (let i = 0, p = 0; i < weight.length; i++, p += 4) {
    const a = pixels[p + 3] / 255; if (!a) continue;
    for (let k = 0; k < 3; k++) { const v = pixels[p + k] * a; if (v > color[p + k]) color[p + k] = v; }
    if (a > weight[i]) weight[i] = a; acc.cover[i] += a;
  }
}
/** Turns an accumulator into straight-alpha RGBA; coverage saturates once views add up to `full` weight. */
export function finishAccumulator(acc, { normal = false, full = 0.5 } = {}) {
  const { color, weight } = acc;
  for (let i = 0, p = 0; i < weight.length; i++, p += 4) {
    if (!weight[i]) { color[p + 3] = 0; continue; }
    if (normal) {
      const x = color[p] / 127.5 - 1, y = color[p + 1] / 127.5 - 1, z = color[p + 2] / 127.5 - 1, l = Math.hypot(x, y, z) || 1;
      color[p] = (x / l + 1) * 127.5; color[p + 1] = (y / l + 1) * 127.5; color[p + 2] = (z / l + 1) * 127.5;
    }
    color[p + 3] = Math.min(1, (acc.cover ? acc.cover[i] : weight[i]) / full) * 255;
  }
  return color;
}

/** Project a view-aligned image onto visible geometry, returning UV-space transparent layers.
 * scale=1 fits the source image within the viewport. offsetX/Y are viewport fractions.
 * Model UVs must already exist and be non-overlapping for independent surface painting.
 */
export async function bakeProjection({ renderer, meshes, camera, image, size = 4096, opacity = 1, scale = 1, offsetX = 0, offsetY = 0, rotation = 0, channel = 'color', flipY = false, normalSpace = 'tangent', viewportAspect, fade = [0.08, 0.24], raw = false, edgeFeather = 0, clipPlane = null, onProgress = () => {} }) {
  if (!meshes?.length) throw new Error('请先导入带 UV 的模型。');
  checkBakeSize(renderer, size);
  const geometryPairs = meshes.filter(m => m.isMesh).map(mesh => ({ mesh, geometry: worldGeometry(mesh) }));
  const valid = geometryPairs.filter(p => !p.geometry.userData.noUV);
  if (!valid.length) throw new Error('模型没有 UV，无法烘焙。请先在 Blender 中展开 UV。');
  const missing = geometryPairs.length - valid.length;
  const viewport = renderer.getSize(new THREE.Vector2());
  const aspect = viewportAspect || viewport.x / viewport.y;
  const imageAspect = (image.naturalWidth || image.width) / (image.naturalHeight || image.height);
  const fit = imageAspect > aspect ? new THREE.Vector2(1, aspect / imageAspect) : new THREE.Vector2(imageAspect / aspect, 1);
  camera.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const depthWidth = Math.min(4096, Math.max(2048, Math.ceil(viewport.x * 2)));
  const depthHeight = Math.max(1, Math.round(depthWidth / aspect));
  const depthTarget = new THREE.WebGLRenderTarget(depthWidth, depthHeight, { depthBuffer: true, stencilBuffer: false });
  depthTarget.depthTexture = new THREE.DepthTexture(depthWidth, depthHeight, THREE.UnsignedIntType);
  const bakeTarget = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, stencilBuffer: false });
  const texture = new THREE.CanvasTexture(image);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const depthMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, clippingPlanes: clipPlane ? [clipPlane] : null });
  const depthScene = new THREE.Scene();
  geometryPairs.forEach(({ geometry }) => depthScene.add(new THREE.Mesh(geometry, depthMaterial)));
  const shader = new THREE.ShaderMaterial({
    uniforms: {
      projectMatrix: { value: matrix }, depthMap: { value: depthTarget.depthTexture }, picture: { value: texture },
      eye: { value: camera.getWorldPosition(new THREE.Vector3()) }, viewDirection: { value: camera.getWorldDirection(new THREE.Vector3()) },
      orthographic: { value: !!camera.isOrthographicCamera }, fit: { value: fit }, viewportAspect: { value: aspect }, offset: { value: new THREE.Vector2(offsetX, offsetY) },
      scale: { value: scale }, angle: { value: rotation * Math.PI / 180 }, opacity: { value: opacity }, normalMode: { value: channel === 'normal' }, normalFlipY: { value: flipY }, viewSpaceNormal: { value: normalSpace === 'view' }, cameraRotation: { value: new THREE.Matrix3().setFromMatrix4(camera.matrixWorld) },
      fadeStart: { value: fade[0] }, fadeEnd: { value: fade[1] }, edgeFeather: { value: edgeFeather },
      clipOn: { value: !!clipPlane }, clipPlane: { value: clipPlane ? new THREE.Vector4(clipPlane.normal.x, clipPlane.normal.y, clipPlane.normal.z, clipPlane.constant) : new THREE.Vector4() }
    }, vertexShader, fragmentShader, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    transparent: false, blending: THREE.NoBlending, toneMapped: false
  });
  const paddingTarget = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, stencilBuffer: false });
  const paddingShader = new THREE.ShaderMaterial({
    uniforms: { inputMap: { value: bakeTarget.texture }, coverageMap: { value: null }, texel: { value: new THREE.Vector2(1 / size, 1 / size) } },
    vertexShader: 'varying vec2 pUV; void main(){ pUV=uv; gl_Position=vec4(position.xy,0.,1.); }',
    // Only grow into texels no UV triangle owns, so occluded neighbours in the atlas stay untouched.
    fragmentShader: `uniform sampler2D inputMap; uniform sampler2D coverageMap; uniform vec2 texel; varying vec2 pUV;
      void main(){ vec4 c=texture2D(inputMap,pUV); if(c.a<0.01 && texture2D(coverageMap,pUV).r<0.5){ vec4 best=c;
        for(int y=-1;y<=1;y++){for(int x=-1;x<=1;x++){vec4 n=texture2D(inputMap,pUV+vec2(float(x),float(y))*texel);if(n.a>best.a)best=n;}}
        c=best; } gl_FragColor=c; }`, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false
  });
  const coverageTarget = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, stencilBuffer: false, format: THREE.RedFormat, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const coverageMaterial = new THREE.ShaderMaterial({ vertexShader: 'void main(){ gl_Position=vec4(uv*2.0-1.0,0.0,1.0); }', fragmentShader: 'void main(){ gl_FragColor=vec4(1.0); }', side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  paddingShader.uniforms.coverageMap.value = coverageTarget.texture;
  const paddingGeometry = new THREE.PlaneGeometry(2, 2), paddingScene = new THREE.Scene();
  const paddingMesh = new THREE.Mesh(paddingGeometry, paddingShader); paddingMesh.frustumCulled = false; paddingScene.add(paddingMesh);
  const previous = { target: renderer.getRenderTarget(), color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear, toneMapping: renderer.toneMapping, xr: renderer.xr.enabled };
  const results = [];
  try {
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(depthTarget);
    renderer.render(depthScene, camera);
    let done = 0;
    for (const { mesh, geometry } of valid) {
      const indices = Array.isArray(mesh.material) ? [...new Set(geometry.groups.map(g => g.materialIndex))] : [0];
      for (const materialIndex of indices) {
        const piece = geometry.clone();
        if (Array.isArray(mesh.material)) {
          const groups = piece.groups.filter(g => g.materialIndex === materialIndex);
          piece.clearGroups();
          groups.forEach(g => piece.addGroup(g.start, g.count, 0));
        }
        const scene = new THREE.Scene();
        const uvMesh = new THREE.Mesh(piece, [shader]);
        if (!piece.groups.length) uvMesh.material = shader;
        uvMesh.frustumCulled = false;
        scene.add(uvMesh);
        uvMesh.material = coverageMaterial;
        renderer.setRenderTarget(coverageTarget); renderer.clear(); renderer.render(scene, camera);
        uvMesh.material = piece.groups.length ? [shader] : shader;
        renderer.setRenderTarget(bakeTarget);
        renderer.clear();
        renderer.render(scene, camera);
        let inputTarget = bakeTarget, outputTarget = paddingTarget;
        // Even pass count leaves the result in bakeTarget; seam padding scales with resolution.
        const passes = Math.max(4, Math.round(size / 512)) & ~1;
        for(let border=0; border<passes; border++) {
          paddingShader.uniforms.inputMap.value = inputTarget.texture;
          renderer.setRenderTarget(outputTarget); renderer.render(paddingScene, camera);
          [inputTarget, outputTarget] = [outputTarget, inputTarget];
        }
        assertGPU(renderer, size);
        // Read straight into the ImageData buffer and flip in place: one size² × 4 byte copy, not three.
        const data = new ImageData(size, size);
        renderer.readRenderTargetPixels(bakeTarget, 0, 0, size, size, new Uint8Array(data.data.buffer));
        assertGPU(renderer, size);
        flipRows(data.data, size);
        // Raw straight-alpha pixels for weighted multi-view merging; a 2D canvas would premultiply and lose low-alpha colour.
        if (raw) { results.push({ mesh, materialIndex, data }); piece.dispose(); continue; }
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error(`浏览器无法创建 ${size}×${size} 画布（内存不足），请关闭其他标签页或降低 UV 尺寸。`);
        ctx.putImageData(data, 0, 0);
        results.push({ mesh, materialIndex, canvas });
        piece.dispose();
      }
      onProgress({ progress: ++done / valid.length, missingUV: missing });
      // Do not yield while owning renderer state; normal render loops may be active.
    }
    return results;
  } finally {
    renderer.setRenderTarget(previous.target);
    renderer.setClearColor(previous.color, previous.alpha);
    renderer.autoClear = previous.autoClear;
    renderer.toneMapping = previous.toneMapping;
    renderer.xr.enabled = previous.xr;
    geometryPairs.forEach(p => p.geometry.dispose());
    paddingTarget.dispose(); coverageTarget.dispose(); coverageMaterial.dispose(); paddingShader.dispose(); paddingGeometry.dispose(); depthTarget.dispose(); bakeTarget.dispose(); texture.dispose(); shader.dispose(); depthMaterial.dispose();
  }
}

/** Converts luminance (an approximate height source) to an OpenGL tangent-space normal map.
 * Uses periodic borders to avoid an artificial seam on repeating textures.
 */
export async function generateNormalMap({ source, size = 4096, strength = 2, flipY = false, onProgress = () => {} }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, 0, 0, size, size);
  const src = ctx.getImageData(0, 0, size, size);
  const heights = new Float32Array(size * size);
  for (let i = 0; i < heights.length; i++) {
    const p = i * 4;
    heights[i] = (src.data[p] * 0.2126 + src.data[p + 1] * 0.7152 + src.data[p + 2] * 0.0722) / 255;
  }
  const out = ctx.createImageData(size, size);
  // Sobel derivatives, normalized independently of output resolution.
  const sample = (x, y) => heights[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = sample(x - 1, y - 1), tc = sample(x, y - 1), tr = sample(x + 1, y - 1);
      const ml = sample(x - 1, y), mr = sample(x + 1, y);
      const bl = sample(x - 1, y + 1), bc = sample(x, y + 1), br = sample(x + 1, y + 1);
      const dx = (tr + 2 * mr + br - tl - 2 * ml - bl) * strength / 4;
      const dy = (bl + 2 * bc + br - tl - 2 * tc - tr) * strength / 4;
      const nx = -dx, ny = flipY ? -dy : dy;
      const len = Math.hypot(nx, ny, 1), p = (y * size + x) * 4;
      out.data[p] = Math.round((nx / len * .5 + .5) * 255);
      out.data[p + 1] = Math.round((ny / len * .5 + .5) * 255);
      out.data[p + 2] = Math.round((1 / len * .5 + .5) * 255);
      out.data[p + 3] = 255;
    }
    if (y % 128 === 0) { onProgress((y + 1) / size); await nextFrame(); }
  }
  ctx.putImageData(out, 0, 0);
  onProgress(1);
  return canvas;
}
