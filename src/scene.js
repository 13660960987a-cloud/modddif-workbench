import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { transferBake } from './transfer-bake.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { bakeAO } from './ao-bake.js';
import { mergeDetail } from './uv-refine.js';
import { bakeVertexCurvature, normalMapCurvature, buildShadeCanvas, applyShade } from './shape-shade.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { bakeProjection, generateNormalMap, gpuLimits, checkBakeSize, accumulateView, accumulateMax, finishAccumulator } from './texture-engine.js';

const canvasOf = size => Object.assign(document.createElement('canvas'), { width: size, height: size });
const imageOf = url => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('无法读取图片，请使用 PNG、JPEG 或 WebP。')); image.src = url; });
const download = (blob, name) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); };
const saveCanvas = (canvas, name) => new Promise(resolve => canvas.toBlob(blob => { if (blob) download(blob, name); resolve(!!blob); }, 'image/png'));
const tick = () => new Promise(r => requestAnimationFrame(r));

export function createScene(container, notify = () => {}, onChange = () => {}) {
  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.localClippingEnabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.className = 'three-canvas';
  container.appendChild(renderer.domElement);
  const perspective = new THREE.PerspectiveCamera(36, 1, .01, 100);
  const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 100);
  let camera = perspective;
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.minDistance = .3; controls.maxDistance = 15;
  // Image-based lighting: metals reflect their surroundings; without it metalness=1 renders black.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), .04).texture;
  scene.environment = envMap; scene.environmentIntensity = .9;
  const hemi = new THREE.HemisphereLight(0xe6ecff, 0x313039, .6);
  const key = new THREE.DirectionalLight(0xffeee2, 2.2); key.position.set(3, 4, 5);
  const fill = new THREE.DirectionalLight(0x9dbdff, .8); fill.position.set(-3, 2, -3);
  const lightState = { angle: 31, height: .6, intensity: 1, unlit: false };
  scene.add(hemi, key, fill);
  const group = new THREE.Group(); scene.add(group);
  const grid = new THREE.GridHelper(6, 30, 0x33353c, 0x1c1e24); grid.position.y = -.01; grid.material.transparent = true; grid.material.opacity = .45; scene.add(grid);
  let model, pending, layers = [], redoStack = [], selectedChannel = 'color', renderMode = 'MAT', busy = false;
  let emissiveStrength = 2;
  let records = [], meshes = [], previewMaterials = [], normalStrength = 1, modelName = '演示角色';
  // While a generated image waits for projection, the viewport renders from its snapshot camera.
  let viewLock = null, lockedCamera = null, lockedKey = '';
  // Section cut {axis, keep, offset}: the removed half is hidden in the view, in generation snapshots and in the bake.
  let cut = null, activePlane = null;
  const shadeOptions = { on: true, cavity: .65, edge: .5, opacity: 1 };
  // glTF UVs put v=0 at the TOP of the image; workbench canvases put v=1 on the first row (flipY=true).
  // Standalone PNGs must follow the model's own convention, or DCC tools map them upside down.
  let uvDown = false;
  // ORM = R ambient occlusion, G roughness, B metalness (glTF layout). Zones assign roughness/metalness per colour cluster.
  let zones = null; const ormOptions = { size: 4096, aoStrength: 1, useZones: true, zoneStrength: .85, wear: .5 };
  ormOptions.aoStrength = 1.3;
  const history = [];
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ color: 0x050608, transparent: true, opacity: .55 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = -.005; scene.add(shadow);
  function resize() {
    // Canvas fills the padding box (inset:0); the border-box rect would stretch the image by the border width.
    const r = { width: container.clientWidth, height: container.clientHeight }; if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height);
    perspective.aspect = r.width / r.height; perspective.updateProjectionMatrix();
    const height = 1.2 / orthographic.zoom;
    orthographic.left = -height * perspective.aspect; orthographic.right = height * perspective.aspect;
    orthographic.top = height; orthographic.bottom = -height; orthographic.zoom = 1; orthographic.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  function emit() { onChange(); container.dispatchEvent(new CustomEvent('workbench-change')); }
  function pushHistory() { history.push(layers.map(l => ({ ...l }))); if (history.length > 15) history.shift(); redoStack = []; }
  function setRender(mode) {
    renderMode = mode; previewMaterials.forEach(m => m.dispose()); previewMaterials = [];
    meshes.forEach(mesh => {
      const rs = records.filter(r => r.mesh === mesh);
      const materials = rs.map(r => {
        if (mode === 'WIR') { const m = new THREE.MeshBasicMaterial({ color: 0xe99078, wireframe: true }); previewMaterials.push(m); return m; }
        if (mode === 'NOR') { const m = new THREE.MeshNormalMaterial({ normalMap: r.material.normalMap, normalScale: r.material.normalScale?.clone() || new THREE.Vector2(1, 1) }); previewMaterials.push(m); return m; }
        if (mode === 'FLA') { const m = new THREE.MeshBasicMaterial({ map: r.material.map, color: r.material.color, side: r.material.side, transparent: r.material.transparent, opacity: r.material.opacity, alphaTest: r.material.alphaTest }); previewMaterials.push(m); return m; }
        return r.material;
      });
      mesh.material = mesh.userData.workbenchMulti ? materials : materials[0];
    });
    applyClip();
  }
  function currentPlane() {
    if (!cut || !model) return null;
    const box = new THREE.Box3().setFromObject(group), center = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(.5);
    const normal = new THREE.Vector3(); normal[cut.axis] = cut.keep;
    const point = center.clone(); point[cut.axis] += cut.offset * half[cut.axis];
    // Three.js keeps the side where normal·p + constant ≥ 0, i.e. the `keep` half.
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
  }
  function applyClip() {
    activePlane = currentPlane(); const planes = activePlane ? [activePlane] : null;
    [...records.map(r => r.material), ...previewMaterials].forEach(m => { m.clippingPlanes = planes; m.needsUpdate = true; });
  }
  function setCut(next) {
    assertUnlocked();
    cut = next ? { axis: ['x', 'y', 'z'].includes(next.axis) ? next.axis : 'x', keep: next.keep < 0 ? -1 : 1, offset: Math.max(-.95, Math.min(.95, Number(next.offset) || 0)) } : null;
    applyClip(); emit(); return cut && { ...cut };
  }
  function getParts() {
    return meshes.map((m, i) => ({ id: m.uuid, name: m.name || m.parent?.name || `部件 ${i + 1}`, visible: m.visible, uv: !!m.geometry.attributes.uv, tris: Math.round((m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3) }));
  }
  function setPartVisible(id, visible) { assertUnlocked(); const m = meshes.find(x => x.uuid === id); if (m) { m.visible = !!visible; emit(); } }
  function soloPart(id) { assertUnlocked(); meshes.forEach(m => { m.visible = m.uuid === id; }); emit(); }
  function showAllParts() { assertUnlocked(); meshes.forEach(m => { m.visible = true; }); emit(); }
  // Bake inputs come from the snapshot, so changing the cut or hiding parts after generating cannot shift the projection.
  function bakeMeshes(snapshot) {
    const hidden = snapshot?.hidden, list = meshes.filter(m => hidden ? !hidden.includes(m.uuid) : m.visible);
    if (!list.length) throw new Error('所有部件都已隐藏，没有可以投射的表面。');
    return list;
  }
  const bakeClip = snapshot => snapshot && 'clip' in snapshot ? snapshot.clip : activePlane?.clone() ?? null;
  // OrbitControls keeps damping inertia in private deltas; zeroing them stops the camera exactly where it is.
  function freezeControls() {
    controls._sphericalDelta?.set(0, 0, 0); controls._panOffset?.set(0, 0, 0);
    if ('_scale' in controls) controls._scale = 1;
    controls.enabled = false;
  }
  function releaseControls() { if (!viewLock) controls.enabled = true; }
  // Square generation frame = centred min(width, height) square of the viewport, in CSS pixels.
  function getFrameRect() {
    const r = { width: container.clientWidth, height: container.clientHeight }, size = Math.min(r.width, r.height);
    return { x: (r.width - size) / 2, y: (r.height - size) / 2, size, width: r.width, height: r.height };
  }
  // Widen the square snapshot camera to the viewport so its frustum lands exactly on the centred square.
  function framedCamera(source) {
    const { width, height } = renderer.getSize(new THREE.Vector2()), key = `${width}x${height}`;
    if (lockedCamera && lockedKey === key) return lockedCamera;
    const aspect = width / height, cam = source.clone();
    if (cam.isPerspectiveCamera) {
      cam.aspect = aspect;
      if (aspect < 1) cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(source.fov) / 2) / aspect));
    } else {
      const half = (source.top - source.bottom) / 2;
      const w = aspect >= 1 ? half * aspect : half, h = aspect >= 1 ? half : half / aspect;
      Object.assign(cam, { left: -w, right: w, top: h, bottom: -h });
    }
    cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    lockedCamera = cam; lockedKey = key; return cam;
  }
  function lockView(snapshot) {
    if (!snapshot?.camera) return;
    freezeControls(); viewLock = snapshot; lockedCamera = null;
    container.classList.add('view-locked');
  }
  function unlockView() {
    if (!viewLock) return;
    // The live camera never moved while locked, so controls resume from the generation pose.
    viewLock = null; lockedCamera = null; controls.enabled = true;
    container.classList.remove('view-locked');
  }
  function assertUnlocked() { if (viewLock) throw new Error('视角已锁定在生成角度。请先投射，或点击“解除锁定”。'); }
  function fitView() {
    assertUnlocked();
    controls.target.set(0, .95, 0); camera.position.set(0, 1.05, 3.7); camera.lookAt(controls.target);
    if (camera.isOrthographicCamera) { camera.zoom = 1; resize(); }
    controls.update();
  }
  function disposeModel() {
    group.clear(); records.forEach(r => { r.canvasTexture?.dispose(); r.normalTexture?.dispose(); r.ormTexture?.dispose(); r.emissiveTexture?.dispose(); r.material.dispose(); });
    meshes.forEach(m => m.geometry.dispose()); previewMaterials.forEach(m => m.dispose());
    previewMaterials = []; records = []; meshes = []; layers = []; history.length = 0; redoStack = [];
  }
  function fit(obj, name) {
    unlockView(); disposeModel(); cut = null; activePlane = null; zones = null; model = obj; modelName = name;
    uvDown = !!obj.userData.workbenchUVDown;
    const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    if (!Number.isFinite(size.length()) || size.length() < 1e-8) throw new Error('模型没有可显示的网格。');
    const scale = 1.85 / Math.max(size.x, size.y, size.z);
    obj.position.sub(center); obj.scale.multiplyScalar(scale); obj.position.multiplyScalar(scale); obj.position.y += .95;
    group.add(obj); obj.updateMatrixWorld(true);
    obj.traverse(mesh => {
      if (!mesh.isMesh) return;
      // An explicit tangent frame keeps normal preview and GLB re-import consistent.
      if(mesh.geometry.attributes.uv && mesh.geometry.attributes.normal && !mesh.geometry.attributes.tangent && mesh.geometry.index){
        mesh.geometry.computeTangents();
        const old=Array.isArray(mesh.material)?mesh.material:[mesh.material];
        old.forEach(m=>{if(m.normalScale?.y<0)m.normalScale.y=Math.abs(m.normalScale.y);});
      }
      meshes.push(mesh); mesh.userData.workbenchMulti = Array.isArray(mesh.material);
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((original, index) => {
        const material = original.isMeshStandardMaterial ? original.clone() : new THREE.MeshStandardMaterial({ color: original.color || 0xc5c2bc, map: original.map, roughness: .65, side: original.side });
        records.push({ key: `${mesh.uuid}:${index}`, mesh, index, original: material.clone(), material, uv: !!mesh.geometry.attributes.uv, colorCanvas: null, normalCanvas: null, ormCanvas: null, ormTexture: null, aoCanvas: null, ormBase: null, zoneLabels: null });
      });
    });
    fitView(); setRender(renderMode); emit();
    const missing = meshes.filter(m => !m.geometry.attributes.uv).length;
    if (missing) notify(`${missing} 个网格没有 UV，无法烘焙，请先展开 UV。`, true);
  }
  async function loadFile(file) {
    if (busy) throw new Error('请等当前操作完成。');
    if (file.size > 500 * 1024 * 1024) throw new Error('模型超过 500 MB，请先简化后再导入。');
    const extension = file.name.split('.').pop().toLowerCase();
    if (!['glb', 'obj', 'fbx'].includes(extension)) throw new Error('请使用内嵌贴图的 GLB，或带 UV 的 OBJ / FBX。');
    const url = URL.createObjectURL(file);
    try {
      const object = extension === 'obj' ? await new OBJLoader().loadAsync(url) : extension === 'fbx' ? await new FBXLoader().loadAsync(url) : (await new GLTFLoader().loadAsync(url)).scene;
      object.userData.workbenchUVDown = extension === 'glb';
      if (extension === 'obj') object.traverse(m => { if (m.isMesh) m.material = new THREE.MeshStandardMaterial({ color: 0xc5c2bc, roughness: .65 }); });
      fit(object, file.name.replace(/\.[^.]+$/, '')); notify(`已导入 ${file.name}`); return true;
    } catch (error) { notify(`模型导入失败：${error.message}`, true); return false; } finally { URL.revokeObjectURL(url); }
  }
  function drawOriginal(record, channel, canvas) {
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
    const map = channel === 'color' ? record.original.map : channel === 'emissive' ? record.original.emissiveMap : record.original.normalMap;
    ctx.fillStyle = channel === 'normal' ? '#8080ff' : channel === 'emissive' ? `#${(record.original.emissive || new THREE.Color(0)).getHexString()}` : `#${record.original.color.getHexString()}`;
    if(channel!=='color'||!map?.image)ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (map?.image) {
      ctx.save();
      // GLTF textures use flipY=false; workbench canvases use canonical UV orientation.
      if (map.flipY === false) { ctx.translate(0, canvas.height); ctx.scale(1, -1); }
      ctx.drawImage(map.image, 0, 0, canvas.width, canvas.height); ctx.restore();
      if (channel === 'color' && record.original.color.getHex() !== 0xffffff) { ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = `#${record.original.color.getHexString()}`; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.globalCompositeOperation = 'source-over'; }
    }
  }
  function recompose() {
    for (const record of records) {
      for (const channel of ['color', 'normal', 'emissive']) {
        const relevant = layers.filter(l => l.channel === channel && l.visible && l.entries.some(e => e.key === record.key));
        const shaded = channel === 'color' && record.shadeCanvas && shadeOptions.on;
        const materialSlot = { color: 'map', normal: 'normalMap', emissive: 'emissiveMap' }[channel];
        const canvasSlot = { color: 'colorCanvas', normal: 'normalCanvas', emissive: 'emissiveCanvas' }[channel];
        const textureSlot = { color: 'canvasTexture', normal: 'normalTexture', emissive: 'emissiveTexture' }[channel];
        if (!relevant.length && !shaded) {
          record.material[materialSlot] = record.original[materialSlot];
          if (channel === 'color') record.material.color.copy(record.original.color);
          if (channel === 'emissive') { record.material.emissive.copy(record.original.emissive || new THREE.Color(0)); record.material.emissiveIntensity = record.original.emissiveIntensity ?? 1; }
          record.material.needsUpdate = true; continue;
        }
        const size = Math.max(shaded ? record.shadeCanvas.width : 0, ...relevant.map(l => l.entries.find(e => e.key === record.key).canvas.width));
        const canvas = record[canvasSlot] || canvasOf(size); record[canvasSlot] = canvas;
        if (canvas.width !== size) canvas.width = canvas.height = size;
        drawOriginal(record, channel, canvas);
        const ctx = canvas.getContext('2d');
        for (const layer of relevant) {
          const entry = layer.entries.find(e => e.key === record.key);
          if (channel === 'normal' && layer.blend) { blendDetailNormal(ctx, entry.canvas, size, layer.opacity); continue; }
          ctx.globalAlpha = layer.opacity;
          ctx.drawImage(entry.canvas, 0, 0, size, size);
        }
        ctx.globalAlpha = 1;
        if (shaded) applyShade(ctx, record.shadeCanvas, size, shadeOptions.opacity);
        if(channel==='color' && (record.original.transparent || record.original.alphaTest>0) && record.original.map?.image){
          ctx.save();ctx.globalCompositeOperation='destination-in';
          if(record.original.map.flipY===false){ctx.translate(0,size);ctx.scale(1,-1);}
          ctx.drawImage(record.original.map.image,0,0,size,size);ctx.restore();
        }
        // A GPU texture keeps its first size; after switching 4K↔8K it must be rebuilt or the viewport keeps the old resolution.
        if (record[textureSlot] && record[textureSlot].userData.size !== size) { record[textureSlot].dispose(); record[textureSlot] = null; }
        if (!record[textureSlot]) {
          const texture = new THREE.CanvasTexture(canvas); texture.userData.size = size; texture.colorSpace = channel === 'normal' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
          texture.flipY = true; texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
          record[textureSlot] = texture;
        }
        record[textureSlot].needsUpdate = true; record.material[materialSlot] = record[textureSlot];
        if (channel === 'color') record.material.color.set(0xffffff);
        if (channel === 'emissive') { record.material.emissive.set(0xffffff); record.material.emissiveIntensity = emissiveStrength; }
        if (channel === 'normal') { record.material.normalMapType = THREE.TangentSpaceNormalMap; record.material.normalScale.set(normalStrength, normalStrength); }
        record.material.needsUpdate = true;
      }
    }
    records.forEach(composeORM);
    setRender(renderMode); emit();
  }
  function flipCanvas(canvas) {
    const t = canvasOf(canvas.width); t.height = canvas.height; t.getContext('2d').drawImage(canvas, 0, 0);
    const ctx = canvas.getContext('2d'); ctx.save(); ctx.setTransform(1, 0, 0, -1, 0, canvas.height); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(t, 0, 0); ctx.restore(); t.width = t.height = 0;
  }
  function thumbnail(source) { const c = canvasOf(96); c.getContext('2d').drawImage(source, 0, 0, 96, 96); return c.toDataURL(); }
  function addLayer(entries, channel, name, blend = false) {
    pushHistory(); layers.push({ id: crypto.randomUUID(), name, channel, visible: true, opacity: 1, blend, thumbnail: thumbnail(pending?.image || entries[0].canvas), entries });
    recompose();
  }
  async function setTexture(url, options = {}) {
    const image = await imageOf(url); pending = { image, url, name: options.name || '导入图片', channel: options.channel || 'color' }; selectedChannel = pending.channel;
    notify(`图片已就绪：${image.naturalWidth} × ${image.naturalHeight}，调整视角后点击投射。`);
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  async function project({ size = 4096, channel = selectedChannel, scale = 1, offsetX = 0, offsetY = 0, rotation = 0, flipY = false, normalSpace = 'tangent', projectionSnapshot = null, normalBlend = false, edgeFeather = 0 } = {}) {
    if (!pending) throw new Error('请先上传或生成一张 PNG 图片。');if(projectionSnapshot?.modelId&&projectionSnapshot.modelId!==model.uuid)throw new Error('生成图片对应的模型已更换，请重新生成当前视角。');
    if (busy) throw new Error('正在处理贴图，请稍候。');
    checkBakeSize(renderer, size); ensureMemory(size, 'bake');
    busy = true; freezeControls(); const previousMode = renderMode;
    try {
      await tick();
      // Use real materials to preserve material group indices in the UV baker.
      setRender('MAT');
      const result = await bakeProjection({ renderer, meshes: bakeMeshes(projectionSnapshot), clipPlane: bakeClip(projectionSnapshot), camera: projectionSnapshot?.camera || camera, viewportAspect: projectionSnapshot?.aspect, image: pending.image, size, channel, scale, offsetX, offsetY, rotation, flipY, normalSpace, edgeFeather: edgeFeather || projectionSnapshot?.edgeFeather || 0 });
      const entries = result.map(e => ({ key: `${e.mesh.uuid}:${e.materialIndex}`, canvas: e.canvas }));
      if (!entries.length) throw new Error('没有可投射的 UV 网格。');
      addLayer(entries, channel, `${channel === 'normal' ? '法线投射' : '颜色投射'} · ${pending.name}`, channel === 'normal' && normalBlend);
      notify(`已烘焙 ${size} × ${size} ${channel === 'normal' ? '法线' : '颜色'}贴图，可旋转模型检查。`);
    } catch (error) { throw explainGPUError(error, size); } finally { busy = false; releaseControls(); setRender(previousMode); }
  }
  async function applyUV({ channel = selectedChannel, size = 4096, flipY = false } = {}) {
    if (!pending) throw new Error('请先上传一张与模型 UV 对应的图片。');
    checkBakeSize(renderer, size); ensureMemory(size, 'bake');
    const canvas = canvasOf(size); const ctx = canvas.getContext('2d'); if (uvDown) { ctx.translate(0, size); ctx.scale(1, -1); } ctx.drawImage(pending.image, 0, 0, size, size); ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (channel === 'normal' && flipY) { const data = ctx.getImageData(0, 0, size, size); for (let i = 1; i < data.data.length; i += 4) data.data[i] = 255 - data.data[i]; ctx.putImageData(data, 0, 0); }
    const entries = records.filter(r => r.uv).map(r => ({ key: r.key, canvas }));
    if (!entries.length) throw new Error('模型没有 UV，请先展开 UV。');
    addLayer(entries, channel, `${channel === 'normal' ? '法线 UV' : '颜色 UV'} · ${pending.name}`); notify('已按现有 UV 替换贴图。');
  }
  async function generateNormal({ size = 4096, strength = 2, flipY = false } = {}) {
    if (busy) throw new Error('请等当前操作完成。'); busy = true;
    try {
      const entries = [];
      for (const record of records.filter(r => r.uv)) {
        const source = canvasOf(size);
        if (record.colorCanvas && layers.some(l => l.channel === 'color' && l.visible)) source.getContext('2d').drawImage(record.colorCanvas, 0, 0, size, size);
        else drawOriginal(record, 'color', source);
        const canvas = await generateNormalMap({ source, size, strength, flipY }); entries.push({ key: record.key, canvas });
      }
      if (!entries.length) throw new Error('当前模型没有可用 UV。');
      addLayer(entries, 'normal', '由颜色亮度生成的法线'); notify('4K 法线图已生成并应用。可切换材质模式检查凹凸。');
    } finally { busy = false; }
  }
  function getLayers() { return layers.map(({ entries, ...layer }) => layer); }
  function setLayer(id, changes) { const l = layers.find(x => x.id === id); if (!l) return; pushHistory(); Object.assign(l, changes); recompose(); }
  function deleteLayer(id) { pushHistory(); layers = layers.filter(l => l.id !== id); recompose(); }
  function undo() { if (!history.length) return; redoStack.push(layers.map(l => ({ ...l }))); layers = history.pop(); recompose(); }
  function redo() { if (!redoStack.length) return; history.push(layers.map(l => ({ ...l }))); layers = redoStack.pop(); recompose(); }
  function setProjection(mode) {
    assertUnlocked();
    const next = mode === 'Orthographic' ? orthographic : perspective;
    if (next === camera) return;
    next.position.copy(camera.position); next.quaternion.copy(camera.quaternion); camera = next;
    controls.object = camera; resize(); controls.update();
  }
  // Renders a 1536² square view with grid/shadow hidden; generation images and projectors share this frame.
  function renderSnapshot(targetCamera) {
    const savedSize=renderer.getSize(new THREE.Vector2()), ratio=renderer.getPixelRatio(), mode=renderMode;
    const visibleGrid=grid.visible,visibleShadow=shadow.visible;grid.visible=false;shadow.visible=false;
    const background=scene.background;scene.background=new THREE.Color(0x777777);
    // Disable tonemapping and IBL, render in flat/unlit mode: the AI must see and paint only albedo,
    // not PBR lighting. Otherwise the returned image has baked-in specular and shadows that get
    // lit a second time when projected back, causing whitening and ghosting.
    const savedTone=renderer.toneMapping, savedEnv=scene.environment, savedEnvInt=scene.environmentIntensity;
    renderer.toneMapping=THREE.NoToneMapping; scene.environment=null; scene.environmentIntensity=0;
    try {
      setRender('FLA');
      renderer.setPixelRatio(1);renderer.setSize(1536,1536,false);renderer.render(scene,targetCamera);
      const image=renderer.domElement.toDataURL('image/png');
      // Same frame on a transparent background: alpha marks the mesh silhouette for background removal.
      scene.background=null;const clearAlpha=renderer.getClearAlpha();renderer.setClearAlpha(0);renderer.render(scene,targetCamera);
      const mask=renderer.domElement.toDataURL('image/png');renderer.setClearAlpha(clearAlpha);
      return {image,mask,camera:targetCamera,aspect:1,modelId:model.uuid,size:1536,clip:activePlane?.clone()??null,hidden:meshes.filter(m=>!m.visible).map(m=>m.uuid)};
    } finally {
      renderer.toneMapping=savedTone; scene.environment=savedEnv; scene.environmentIntensity=savedEnvInt;
      renderer.setPixelRatio(ratio);renderer.setSize(savedSize.x,savedSize.y,false);scene.background=background;grid.visible=visibleGrid;shadow.visible=visibleShadow;
      setRender(mode);
      renderer.render(scene,viewLock?framedCamera(viewLock.camera):camera);
    }
  }
  function captureForGeneration() {
    if (!model) throw new Error('请先导入模型。');
    // Stop inertia first: the snapshot and the locked preview must be the pose the user released on.
    freezeControls(); controls.update();
    const targetCamera=camera.clone();
    if(targetCamera.isPerspectiveCamera)targetCamera.aspect=1;
    else { const height=(targetCamera.top-targetCamera.bottom)/2;targetCamera.left=-height;targetCamera.right=height; }
    targetCamera.updateProjectionMatrix();targetCamera.updateMatrixWorld();
    try { return renderSnapshot(targetCamera); } finally { releaseControls(); }
  }
  // Six axis views. Orthographic keeps texel density even across the model, which suits merged projection.
  const FACES = {
    front: { dir: [0, 0, 1], up: [0, 1, 0] }, back: { dir: [0, 0, -1], up: [0, 1, 0] },
    left: { dir: [-1, 0, 0], up: [0, 1, 0] }, right: { dir: [1, 0, 0], up: [0, 1, 0] },
    top: { dir: [0, 1, 0], up: [0, 0, -1] }, bottom: { dir: [0, -1, 0], up: [0, 0, 1] },
  };
  function modelBounds() {
    const box = new THREE.Box3().setFromObject(group);
    return { box, center: box.getCenter(new THREE.Vector3()), radius: box.getSize(new THREE.Vector3()).length() / 2 };
  }
  function faceCamera(face) {
    const spec = FACES[face]; if (!spec) throw new Error(`未知视角：${face}`);
    const { box, center, radius } = modelBounds();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, radius * .5, radius * 5.5);
    cam.up.set(...spec.up); cam.position.copy(center).addScaledVector(new THREE.Vector3(...spec.dir), radius * 3); cam.lookAt(center); cam.updateMatrixWorld();
    // Tight square framing from the bounding-box corners in camera space.
    let half = 0; const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) { p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(cam.matrixWorldInverse); half = Math.max(half, Math.abs(p.x), Math.abs(p.y)); }
    half *= 1.06; Object.assign(cam, { left: -half, right: half, top: half, bottom: -half }); cam.updateProjectionMatrix();
    return cam;
  }
  function captureFaces(faces = Object.keys(FACES)) {
    if (!model) throw new Error('请先导入模型。');
    return faces.map(face => ({ face, ...renderSnapshot(faceCamera(face)) }));
  }
  // Moves the live camera to look from one of the six axes, for inspecting that side.
  function viewFrom(face) {
    assertUnlocked(); const spec = FACES[face]; if (!spec) return;
    const { center } = modelBounds(), distance = camera.position.distanceTo(controls.target);
    // Orbit controls degenerate looking straight up/down; nudge towards the front.
    const dir = new THREE.Vector3(...spec.dir).add(new THREE.Vector3(0, 0, spec.dir[1] ? .02 : 0)).normalize();
    controls.target.copy(center); camera.position.copy(center).addScaledVector(dir, distance); camera.lookAt(center); controls.update();
  }
  function existingCoverage(key, channel, size, excludeId) {
    const relevant = layers.filter(l => l.id !== excludeId && l.channel === channel && l.visible && l.entries.some(e => e.key === key));
    if (!relevant.length) return null;
    const c = canvasOf(size), ctx = c.getContext('2d');
    for (const l of relevant) { ctx.globalAlpha = l.opacity; ctx.drawImage(l.entries.find(e => e.key === key).canvas, 0, 0, size, size); }
    const alpha = ctx.getImageData(0, 0, size, size).data; c.width = c.height = 0; return alpha;
  }
  // Bakes several view images into one layer. Each texel takes a facing-weighted average, so overlaps blend instead of seaming.
  async function projectViews({ views = [], size = 4096, channel = 'color', normalSpace = 'view', replaceId = null, name = '多视角投射', fillOnly = false, normalBlend = false } = {}) {
    const usable = views.filter(v => v?.image && v.snapshot?.camera);
    if (!usable.length) throw new Error('没有可投射的视角图片。');
    if (usable.some(v => v.snapshot.modelId !== model.uuid)) throw new Error('这些视角图片属于之前的模型，请重新生成。');
    if (busy) throw new Error('正在处理贴图，请稍候。');
    checkBakeSize(renderer, size); ensureMemory(size, 'bake');
    busy = true; const previousMode = renderMode, acc = new Map();
    try {
      setRender('MAT');
      for (const view of usable) {
        const image = await imageOf(view.image);
        const result = await bakeProjection({ renderer, meshes: bakeMeshes(view.snapshot), clipPlane: bakeClip(view.snapshot), camera: view.snapshot.camera, viewportAspect: 1, image, size, channel, normalSpace: view.normalSpace || normalSpace, fade: [.15, .97], raw: true });
        for (const e of result) {
          const key = `${e.mesh.uuid}:${e.materialIndex}`;
          let a = acc.get(key); if (!a) acc.set(key, a = { color: new Uint8ClampedArray(size * size * 4), weight: new Float32Array(size * size) });
          (channel === 'emissive' ? accumulateMax : accumulateView)(a, e.data.data);
        }
      }
      const entries = [...acc].map(([key, a]) => {
        const canvas = canvasOf(size), ctx = canvas.getContext('2d');
        if (!ctx) throw new Error(`浏览器无法创建 ${size}×${size} 画布（内存不足），请改用较低尺寸。`);
        const pixels = finishAccumulator(a, { normal: channel === 'normal' });
        // Fill-only: keep what earlier layers already painted, and only add where they left gaps.
        if (fillOnly) { const covered = existingCoverage(key, channel, size, replaceId); if (covered) for (let p = 3; p < pixels.length; p += 4) pixels[p] = pixels[p] * (255 - covered[p]) / 255; }
        ctx.putImageData(new ImageData(pixels, size, size), 0, 0);
        return { key, canvas };
      });
      if (!entries.length) throw new Error('没有可投射的 UV 网格。');
      pushHistory(); if (replaceId) layers = layers.filter(l => l.id !== replaceId);
      const id = crypto.randomUUID();
      layers.push({ id, name: `${name} · ${usable.length} 面`, channel, visible: true, opacity: 1, blend: channel === 'normal' && normalBlend, thumbnail: thumbnail(entries[0].canvas), entries });
      recompose();
      notify(`已把 ${usable.length} 个视角合并烘焙到 ${size} × ${size} ${channel === 'normal' ? '法线' : '颜色'}贴图。`);
      return id;
    } catch (error) { throw explainGPUError(error, size); } finally { busy = false; setRender(previousMode); }
  }
  // Reoriented normal mapping (RNM): detail normals bend the base normal instead of replacing it.
  function blendDetailNormal(ctx, detailCanvas, size, opacity) {
    const base = ctx.getImageData(0, 0, size, size), d = canvasOf(size), dx = d.getContext('2d');
    dx.drawImage(detailCanvas, 0, 0, size, size);
    const det = dx.getImageData(0, 0, size, size).data, b = base.data; d.width = d.height = 0;
    for (let p = 0; p < b.length; p += 4) {
      const a = det[p + 3] / 255 * opacity; if (!a) continue;
      const tx = b[p] / 127.5 - 1, ty = b[p + 1] / 127.5 - 1, tz = b[p + 2] / 127.5;          // base + (0,0,1)
      const ux = -(det[p] / 127.5 - 1), uy = -(det[p + 1] / 127.5 - 1), uz = det[p + 2] / 127.5 - 1;
      const k = (tx * ux + ty * uy + tz * uz) / tz;
      let rx = tx * k - ux, ry = ty * k - uy, rz = tz * k - uz; const l = Math.hypot(rx, ry, rz) || 1; rx /= l; ry /= l; rz /= l;
      b[p] += ((rx + 1) * 127.5 - b[p]) * a; b[p + 1] += ((ry + 1) * 127.5 - b[p + 1]) * a; b[p + 2] += ((rz + 1) * 127.5 - b[p + 2]) * a;
    }
    ctx.putImageData(base, 0, 0);
  }
  const canvasTexture = (canvas, srgb) => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.flipY = true; t.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8); return t; };
  // Generation output (e.g. Tripo 4K/8K maps on the original UVs) re-baked onto the current UV layout.
  async function transferHires(file, { size = 4096 } = {}) {
    if (!model) throw new Error('请先导入模型。');
    if (busy) throw new Error('正在处理贴图，请稍候。');
    checkBakeSize(renderer, size); ensureMemory(size, 'bake');
    const url = URL.createObjectURL(file); busy = true;
    try {
      const src = (await new GLTFLoader().loadAsync(url)).scene, srcMeshes = []; src.traverse(m => { if (m.isMesh) srcMeshes.push(m); });
      const targets = meshes.filter(m => m.geometry.attributes.uv);
      if (srcMeshes.length !== targets.length) throw new Error(`原件有 ${srcMeshes.length} 个网格，当前模型有 ${targets.length} 个，无法对应。`);
      const report = [];
      for (let i = 0; i < targets.length; i++) {
        const sm = srcMeshes[i], sMat = Array.isArray(sm.material) ? sm.material[0] : sm.material, record = records.find(r => r.mesh === targets[i]);
        const maps = [['color', sMat.map], ['normal', sMat.normalMap], ['orm', sMat.roughnessMap || sMat.metalnessMap]].filter(([, t]) => t?.image).map(([name, texture]) => ({ name, texture, normal: name === 'normal' }));
        if (!maps.length) throw new Error('原件里没有可转移的贴图。');
        const sizes = Object.fromEntries(maps.map(m => [m.name, `${m.texture.image.width}×${m.texture.image.height}`]));
        const { canvases, matched, total } = await transferBake({ renderer, target: targets[i].geometry, source: sm.geometry, maps, size });
        const o = record.original;
        if (canvases.color) { o.map?.dispose?.(); o.map = canvasTexture(canvases.color, true); o.color.set(0xffffff); }
        if (canvases.normal) { o.normalMap = canvasTexture(canvases.normal, false); o.normalScale.set(1, 1); }
        if (canvases.orm) { record.ormBase = canvases.orm; o.roughness = 1; o.metalness = 1; }
        report.push({ matched, total, sizes });
      }
      src.traverse(m => { if (m.isMesh) { m.geometry.dispose(); [].concat(m.material).forEach(x => { ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'].forEach(k => x[k]?.dispose()); x.dispose(); }); } });
      recompose();
      const r = report[0];
      notify(`已把原件贴图（${Object.entries(r.sizes).map(([k, v]) => `${{ color: '颜色', normal: '法线', orm: 'ORM' }[k]} ${v}`).join('、')}）转烘焙到当前 UV，输出 ${size}×${size}；三角形对应 ${r.matched}/${r.total}。`);
      return report;
    } finally { busy = false; URL.revokeObjectURL(url); }
  }
  // Soft edges everywhere: vertices that share a position (UV seams, split hard edges) get one
  // averaged normal. Normals of already-soft vertices are kept, because the generator's normal
  // map was baked against them; recomputing from faces would shift that bake.
  function smoothNormals() {
    assertUnlocked(); let seamVerts = 0, hardSeams = 0, maxTurn = 0;
    for (const mesh of meshes) {
      const g = mesh.geometry, pos = g.attributes.position;
      if (!g.attributes.normal) { g.computeVertexNormals(); }
      const box = new THREE.Box3().setFromBufferAttribute(pos), q = 2e4 / Math.max(1e-6, box.getSize(new THREE.Vector3()).length());
      const groups = new Map();
      for (let i = 0; i < pos.count; i++) { const k = `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`; const list = groups.get(k); list ? list.push(i) : groups.set(k, [i]); }
      const n = g.attributes.normal, v = new THREE.Vector3(), w = new THREE.Vector3();
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        v.set(0, 0, 0); for (const i of list) v.add(w.fromBufferAttribute(n, i)); v.normalize();
        let split = false;
        for (const i of list) { const turn = Math.acos(Math.min(1, w.fromBufferAttribute(n, i).dot(v))) * 180 / Math.PI; if (turn > 1) split = true; maxTurn = Math.max(maxTurn, turn); n.setXYZ(i, v.x, v.y, v.z); }
        seamVerts += list.length; if (split) hardSeams++;
      }
      n.needsUpdate = true; if (g.attributes.uv && g.index) g.computeTangents();
    }
    emit();
    notify(hardSeams ? `已软化 ${hardSeams} 处硬边（接缝顶点 ${seamVerts} 个），法线最大改变 ${maxTurn.toFixed(1)}°。` : `检查了 ${seamVerts} 个接缝顶点：原本已全部是软边，未作改动。`);
    return { hardSeams, seamVerts, maxTurnDeg: maxTurn };
  }
  // Shape shading: cavity darkening + ridge highlight computed from mesh curvature, normal-map detail and AO.
  async function bakeShapeShade({ size = 4096 } = {}) {
    if (busy) throw new Error('正在处理贴图，请稍候。');
    const usable = records.filter(r => r.uv); if (!usable.length) throw new Error('模型没有 UV。');
    checkBakeSize(renderer, size); ensureMemory(size, 'bake'); busy = true;
    try {
      const t = performance.now();
      if (!usable.some(r => r.aoCanvas)) { const maps = await bakeAO({ renderer, meshes: meshes.filter(m => m.visible), size, samples: 96 }); for (const r of records) if (maps.has(r.key)) r.aoCanvas = maps.get(r.key); }
      for (const r of usable) {
        const { curvature } = bakeVertexCurvature({ renderer, mesh: r.mesh, materialIndex: r.index, size });
        // Measured: normal-map divergence is per-texel noise on generator bakes (correlation 0.003 with the
        // mesh), so only the mesh curvature and AO drive shading — both follow the real carved forms.
        let ao = null; if (r.aoCanvas) { const a = canvasOf(size); a.getContext('2d').drawImage(r.aoCanvas, 0, 0, size, size); const d = a.getContext('2d').getImageData(0, 0, size, size).data; ao = new Uint8Array(size * size); for (let i = 0; i < ao.length; i++) ao[i] = d[i * 4]; a.width = a.height = 0; }
        r.shadeData = { size, curvature, ao };
        r.shadeCanvas = buildShadeCanvas({ size, curvature, ao, cavity: shadeOptions.cavity, edge: shadeOptions.edge });
      }
      shadeOptions.on = true; recompose();
      notify(`已按模型形状加明暗（${size}×${size}）：凹处压暗、凸棱提亮，用时 ${((performance.now() - t) / 1000).toFixed(1)} 秒。`);
      return { ms: performance.now() - t };
    } catch (error) { throw explainGPUError(error, size); } finally { busy = false; }
  }
  // UV refinement: hand the current atlas to the image model, keep only its fine detail.
  function getUvSources({ channel = 'color', size = 2048 } = {}) {
    return records.filter(r => r.uv).map(r => { const c = canvasOf(size);
      if (channel === 'color') { c.getContext('2d').drawImage(colorSource(r, size), 0, 0); }
      else { drawOriginal(r, 'normal', c); if (r.normalCanvas && layers.some(l => l.channel === 'normal' && l.visible)) c.getContext('2d').drawImage(r.normalCanvas, 0, 0, size, size); }
      return { key: r.key, image: c.toDataURL('image/png') }; });
  }
  async function applyUvRefine({ results, channel = 'color', size = 4096, strength = 1 }) {
    if (busy) throw new Error('正在处理贴图，请稍候。');
    checkBakeSize(renderer, size); ensureMemory(size, 'bake'); busy = true;
    try {
      const entries = []; let kept = 0, skipped = 0;
      for (const { key, image } of results) {
        const r = records.find(x => x.key === key); if (!r) continue;
        const cur = canvasOf(size); if (channel === 'color') cur.getContext('2d').drawImage(colorSource(r, size), 0, 0); else { drawOriginal(r, 'normal', cur); if (r.normalCanvas) cur.getContext('2d').drawImage(r.normalCanvas, 0, 0, size, size); }
        const ai = canvasOf(size); ai.getContext('2d').drawImage(await imageOf(image), 0, 0, size, size);
        const cov = uvMask(r, size).getContext('2d').getImageData(0, 0, size, size).data, coverage = new Uint8Array(size * size);
        for (let i = 0; i < coverage.length; i++) coverage[i] = cov[i * 4 + 3] > 127 ? 1 : 0;
        const m = mergeDetail(cur.getContext('2d').getImageData(0, 0, size, size), ai.getContext('2d').getImageData(0, 0, size, size), coverage, { strength, channel });
        const out = canvasOf(size); out.getContext('2d').putImageData(m.data, 0, 0); entries.push({ key, canvas: out });
        kept += m.kept; skipped += m.skipped; cur.width = cur.height = ai.width = ai.height = 0;
      }
      if (!entries.length) throw new Error('没有可细化的 UV 贴图。');
      pushHistory(); layers.push({ id: crypto.randomUUID(), name: channel === 'normal' ? 'UV 细化 · 法线' : 'UV 细化 · 颜色', channel, visible: true, opacity: 1, blend: false, thumbnail: thumbnail(entries[0].canvas), entries });
      recompose();
      notify(`UV 细化完成：${kept} 块加了细节，${skipped} 块是大片平面已跳过（不会被乱画）。可调图层不透明度控制强弱。`);
      return { kept, skipped };
    } catch (error) { throw explainGPUError(error, size); } finally { busy = false; }
  }
  function setShadeOptions(patch) {
    Object.assign(shadeOptions, patch);
    if ('cavity' in patch || 'edge' in patch) for (const r of records) if (r.shadeData) r.shadeCanvas = buildShadeCanvas({ ...r.shadeData, cavity: shadeOptions.cavity, edge: shadeOptions.edge });
    recompose(); return { ...shadeOptions };
  }
  async function bakeAOMap({ size = ormOptions.size, samples = 96 } = {}) {
    if (busy) throw new Error('正在处理贴图，请稍候。');
    checkBakeSize(renderer, size); ensureMemory(size, 'bake'); busy = true;
    try {
      const t = performance.now(), maps = await bakeAO({ renderer, meshes: meshes.filter(m => m.visible), size, samples });
      for (const r of records) if (maps.has(r.key)) r.aoCanvas = maps.get(r.key);
      recompose(); notify(`已烘焙 ${size}×${size} AO（${samples} 个方向），用时 ${((performance.now() - t) / 1000).toFixed(1)} 秒。`);
      return { size, ms: performance.now() - t };
    } catch (error) { throw explainGPUError(error, size); } finally { busy = false; }
  }
  function uvMask(record, size) {
    const c = canvasOf(size), x = c.getContext('2d'), g = record.mesh.geometry, uv = g.attributes.uv, idx = g.index;
    x.fillStyle = '#fff'; x.beginPath();
    const groups = g.groups.length ? g.groups.filter(gr => gr.materialIndex === record.index) : [{ start: 0, count: idx ? idx.count : uv.count }];
    for (const gr of groups) for (let t = gr.start; t < gr.start + gr.count; t += 3) {
      for (let k = 0; k < 3; k++) { const v = idx ? idx.getX(t + k) : t + k, px = uv.getX(v) * size, py = (1 - uv.getY(v)) * size; k ? x.lineTo(px, py) : x.moveTo(px, py); }
      x.closePath();
    }
    x.fill(); return c;
  }
  function colorSource(record, size) { const c = canvasOf(size); if (record.colorCanvas && layers.some(l => l.channel === 'color' && l.visible && l.entries.some(e => e.key === record.key))) c.getContext('2d').drawImage(record.colorCanvas, 0, 0, size, size); else drawOriginal(record, 'color', c); return c; }
  // Guesses PBR values from a cluster colour; every value stays editable.
  function guessMaterial([r, g, b]) {
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, sat = max ? (max - min) / max : 0;
    let hue = 0; if (max !== min) { const d = (max - min) * 255; hue = max * 255 === r ? ((g - b) / d) % 6 : max * 255 === g ? (b - r) / d + 2 : (r - g) / d + 4; hue = (hue * 60 + 360) % 360; }
    // Real PBR metalness is 0 or 1; the zone's roughness carries the look. Every value stays editable.
    if (sat > .28 && hue >= 25 && hue <= 62 && max > .45) return { label: '金', metal: 1, rough: .32 };
    if (sat > .22 && sat < .65 && hue < 45 && max > .33) return { label: '铜', metal: 1, rough: .48 };
    if (sat > .22 && hue < 45) return { label: '木 / 皮革', metal: 0, rough: .72 };
    if (sat < .16 && max > .6) return { label: '银', metal: 1, rough: .3 };
    if (max < .22) return { label: '黑铁', metal: 1, rough: .62 };
    if (sat < .16) return { label: '灰铁', metal: 1, rough: .5 };
    return { label: '其他（非金属）', metal: 0, rough: .65 };
  }
  // Material zones from the current colour texture: k-means in RGB over UV-covered texels.
  function computeZones({ count = 6 } = {}) {
    const usable = records.filter(r => r.uv); if (!usable.length) throw new Error('模型没有 UV。');
    const N = 1024, samples = [];
    for (const r of usable) {
      const col = colorSource(r, N).getContext('2d').getImageData(0, 0, N, N).data, mask = uvMask(r, N).getContext('2d').getImageData(0, 0, N, N).data;
      for (let i = 0; i < N * N; i += 7) if (mask[i * 4 + 3] > 127) samples.push(...zoneFeature(col, i * 4));
    }
    const n = samples.length / 3; if (n < count * 10) throw new Error('可用颜色太少，无法分材质。');
    let centers = []; // k-means++ style spread init by luminance order
    const order = [...Array(n).keys()].sort((a, b) => (samples[a * 3] + samples[a * 3 + 1] + samples[a * 3 + 2]) - (samples[b * 3] + samples[b * 3 + 1] + samples[b * 3 + 2]));
    for (let k = 0; k < count; k++) { const i = order[Math.floor((k + .5) / count * n)]; centers.push([samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]]); }
    const assign = new Uint8Array(n);
    for (let it = 0; it < 12; it++) {
      const sum = centers.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity; const r = samples[i * 3], g = samples[i * 3 + 1], b = samples[i * 3 + 2];
        for (let k = 0; k < count; k++) { const c = centers[k], d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2; if (d < bd) { bd = d; best = k; } }
        assign[i] = best; const s0 = sum[best]; s0[0] += r; s0[1] += g; s0[2] += b; s0[3]++;
      }
      centers = sum.map((s0, k) => s0[3] ? [s0[0] / s0[3], s0[1] / s0[3], s0[2] / s0[3]] : centers[k]);
    }
    const share = centers.map(() => 0), rgb = centers.map(() => [0, 0, 0]);
    for (let i = 0; i < n; i++) share[assign[i]]++;
    // Report each cluster by its mean real colour (features are not RGB).
    for (const r of usable) { const col = colorSource(r, N).getContext('2d').getImageData(0, 0, N, N).data, mask = uvMask(r, N).getContext('2d').getImageData(0, 0, N, N).data;
      for (let i = 0; i < N * N; i += 7) if (mask[i * 4 + 3] > 127) { const f = zoneFeature(col, i * 4); let best = 0, bd = Infinity; for (let k = 0; k < count; k++) { const c = centers[k], d = (f[0] - c[0]) ** 2 + (f[1] - c[1]) ** 2 + (f[2] - c[2]) ** 2; if (d < bd) { bd = d; best = k; } } rgb[best][0] += col[i * 4]; rgb[best][1] += col[i * 4 + 1]; rgb[best][2] += col[i * 4 + 2]; } }
    const mean = rgb.map((c, k) => share[k] ? c.map(v => Math.round(v / share[k])) : [128, 128, 128]);
    zones = { features: centers, centers: mean, params: mean.map(c => guessMaterial(c)), share: share.map(v => v / n) };
    // Clusters that guessed the same material are one zone for the artist; keep the first, fold the rest into it.
    const keep = [], remap = [];
    zones.params.forEach((pp, k) => { const j = keep.findIndex(i => zones.params[i].label === pp.label); if (j < 0) { remap[k] = keep.length; keep.push(k); } else { remap[k] = j; } });
    if (keep.length < zones.params.length) {
      const share2 = keep.map(() => 0); zones.share.forEach((v, k) => share2[remap[k]] += v);
      zones = { features: zones.features, remap, centers: keep.map(i => zones.centers[i]), params: keep.map(i => ({ ...zones.params[i] })), share: share2 };
    }
    labelZones(); recompose(); notify(`已按颜色分出 ${zones.params.length} 种材质，可逐个调整金属度和粗糙度。`);
    return getZones();
  }
  // Lightness plus strongly weighted chroma, so gold vs silver separates before light vs dark silver.
  function zoneFeature(d, p) {
    const r = d[p] / 255, g = d[p + 1] / 255, b = d[p + 2] / 255, L = .299 * r + .587 * g + .114 * b;
    return [L * 100, (r - g) * 260, ((r + g) / 2 - b) * 260];
  }
  function labelZones() {
    const size = ormOptions.size, N = 1024, F = zones.features;
    for (const r of records.filter(x => x.uv)) {
      const d = colorSource(r, N).getContext('2d').getImageData(0, 0, N, N).data, small = new Uint8Array(N * N);
      const remap = zones.remap;
      for (let i = 0; i < small.length; i++) { const f = zoneFeature(d, i * 4); let best = 0, bd = Infinity; for (let k = 0; k < F.length; k++) { const c = F[k], dd = (f[0] - c[0]) ** 2 + (f[1] - c[1]) ** 2 + (f[2] - c[2]) ** 2; if (dd < bd) { bd = dd; best = k; } } small[i] = remap ? remap[best] : best; }
      // 5×5 majority filter removes speckle so each zone is a clean region.
      const zoneCount = zones.params.length, clean = new Uint8Array(N * N), votes = new Uint16Array(zoneCount);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        votes.fill(0);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = Math.min(N - 1, Math.max(0, y + dy)), xx = Math.min(N - 1, Math.max(0, x + dx)); votes[small[yy * N + xx]]++; }
        let best = 0; for (let k = 1; k < zoneCount; k++) if (votes[k] > votes[best]) best = k; clean[y * N + x] = best;
      }
      removeSmallIslands(clean, N, Math.round(N * N * .0004));
      const labels = new Uint8Array(size * size), s0 = N / size;
      for (let y = 0; y < size; y++) { const row = Math.floor(y * s0) * N; for (let x = 0; x < size; x++) labels[y * size + x] = clean[row + Math.floor(x * s0)]; }
      r.zoneLabels = labels;
    }
  }
  // Regions smaller than minArea take the label that surrounds them most, so one casting stays one material.
  function removeSmallIslands(labels, N, minArea) {
    const seen = new Uint8Array(N * N), stack = new Int32Array(N * N), members = [];
    for (let start = 0; start < labels.length; start++) {
      if (seen[start]) continue;
      const k = labels[start]; let top = 0; stack[top++] = start; seen[start] = 1; members.length = 0;
      const border = new Map();
      while (top) {
        const i = stack[--top]; members.push(i); const x = i % N;
        for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, i >= N ? i - N : -1, i < N * N - N ? i + N : -1]) {
          if (j < 0) continue;
          if (labels[j] === k) { if (!seen[j]) { seen[j] = 1; stack[top++] = j; } } else border.set(labels[j], (border.get(labels[j]) || 0) + 1);
        }
      }
      if (members.length < minArea && border.size) { let best = -1, bc = -1; for (const [l, c] of border) if (c > bc) { bc = c; best = l; } for (const i of members) labels[i] = best; }
    }
  }
  // How well an image matches this model's UV layout (0–1): high for a texture atlas, low for a view render.
  async function uvMatchScore(url) {
    const image = await imageOf(url); if (Math.abs(image.naturalWidth - image.naturalHeight) > 2) return 0;
    const N = 256, usable = records.filter(r => r.uv); if (!usable.length) return 0;
    const uvC = canvasOf(N), ux = uvC.getContext('2d'); for (const r of usable) ux.drawImage(uvMask(r, N), 0, 0);
    if (uvDown) flipCanvas(uvC);
    const um = ux.getImageData(0, 0, N, N).data, ic = canvasOf(N), ix = ic.getContext('2d'); ix.drawImage(image, 0, 0, N, N); const im = ix.getImageData(0, 0, N, N).data;
    // Content = opaque and not the flat padding colour found in the corners.
    const bg = [im[0], im[1], im[2]]; let inter = 0, uni = 0;
    for (let i = 0; i < N * N; i++) { const p = i * 4, content = im[p + 3] > 20 && (Math.abs(im[p] - bg[0]) + Math.abs(im[p + 1] - bg[1]) + Math.abs(im[p + 2] - bg[2]) > 18 || im[p + 3] < 250 && im[p + 3] > 20), uvOn = um[p + 3] > 127; if (content && uvOn) inter++; if (content || uvOn) uni++; }
    return uni ? inter / uni : 0;
  }
  // Lights up one zone on the model (emissive overlay) so artists can see what a slider row controls.
  let highlight = null;
  function highlightZone(k) {
    for (const r of records) {
      r.material.emissiveMap?.userData?.zoneHighlight && r.material.emissiveMap.dispose();
      if (k == null || !r.zoneLabels) { r.material.emissiveMap = r.emissiveTexture && layers.some(l => l.channel === 'emissive' && l.visible) ? r.emissiveTexture : (r.original.emissiveMap || null); if (r.material.emissiveMap === r.emissiveTexture && r.emissiveTexture) { r.material.emissive.set(0xffffff); r.material.emissiveIntensity = emissiveStrength; } else r.material.emissive?.copy(r.original.emissive || new THREE.Color(0)); r.material.needsUpdate = true; continue; }
      const size = Math.sqrt(r.zoneLabels.length), N = 1024, step = size / N, c = canvasOf(N), x = c.getContext('2d'), im = x.createImageData(N, N);
      for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) { const on = r.zoneLabels[Math.floor(y * step) * size + Math.floor(xx * step)] === k, p = (y * N + xx) * 4; im.data[p] = im.data[p + 1] = im.data[p + 2] = on ? 255 : 0; im.data[p + 3] = 255; }
      x.putImageData(im, 0, 0);
      const t = canvasTexture(c, true); t.userData.zoneHighlight = true;
      r.material.emissiveMap = t; r.material.emissive.set(0xee9274); r.material.emissiveIntensity = .9; r.material.needsUpdate = true;
    }
    highlight = k;
  }
  function getZones() { return zones && zones.centers.map((c, i) => ({ index: i, color: `rgb(${c.join(',')})`, share: zones.share[i], ...zones.params[i] })); }
  function setZone(i, patch) { if (!zones?.params[i]) return; Object.assign(zones.params[i], patch); records.forEach(composeORM); setRender(renderMode); emit(); }
  function setORMOptions(patch) { Object.assign(ormOptions, patch); records.forEach(composeORM); setRender(renderMode); emit(); }
  function drawORMBase(record, canvas) {
    const size = canvas.width, ctx = canvas.getContext('2d'), o = record.original, src = record.ormBase || o.roughnessMap?.image || o.metalnessMap?.image;
    if (src) {
      ctx.save(); const map = record.ormBase ? null : (o.roughnessMap || o.metalnessMap);
      if (map?.flipY === false) { ctx.translate(0, size); ctx.scale(1, -1); }
      ctx.drawImage(src, 0, 0, size, size); ctx.restore();
      if (!record.ormBase && (o.roughness !== 1 || o.metalness !== 1 || !o.roughnessMap || !o.metalnessMap)) {
        const im = ctx.getImageData(0, 0, size, size), p = im.data;
        for (let i = 0; i < p.length; i += 4) { p[i + 1] = o.roughnessMap ? p[i + 1] * o.roughness : o.roughness * 255; p[i + 2] = o.metalnessMap ? p[i + 2] * o.metalness : o.metalness * 255; if (!o.aoMap) p[i] = 255; }
        ctx.putImageData(im, 0, 0);
      }
    } else { ctx.fillStyle = `rgb(255,${Math.round(o.roughness * 255)},${Math.round(o.metalness * 255)})`; ctx.fillRect(0, 0, size, size); }
  }
  function composeORM(record) {
    const active = record.ormBase || record.aoCanvas || (zones && ormOptions.useZones && record.zoneLabels);
    if (!active) { for (const k of ['aoMap', 'roughnessMap', 'metalnessMap']) record.material[k] = record.original[k]; record.material.roughness = record.original.roughness; record.material.metalness = record.original.metalness; return; }
    const size = ormOptions.size, canvas = record.ormCanvas && record.ormCanvas.width === size ? record.ormCanvas : canvasOf(size); record.ormCanvas = canvas;
    drawORMBase(record, canvas);
    const ctx = canvas.getContext('2d'), im = ctx.getImageData(0, 0, size, size), p = im.data;
    let ao = null; if (record.aoCanvas) { const t = canvasOf(size); t.getContext('2d').drawImage(record.aoCanvas, 0, 0, size, size); ao = t.getContext('2d').getImageData(0, 0, size, size).data; t.width = t.height = 0; }
    const labels = zones && ormOptions.useZones && record.zoneLabels?.length === size * size ? record.zoneLabels : null, params = zones?.params;
    let col = null; if (labels && ormOptions.wear > 0) { const cc = colorSource(record, size); col = cc.getContext('2d').getImageData(0, 0, size, size).data; cc.width = cc.height = 0; }
    for (let i = 0, q = 0; q < p.length; i++, q += 4) {
      if (ao) { const v = ao[q] / 255; p[q] = 255 * Math.pow(1 - (1 - v) * Math.min(1, ormOptions.aoStrength), Math.max(1, ormOptions.aoStrength)); }
      // Zones pull the generator's per-texel values toward the chosen material, keeping their micro variation.
      if (labels) { const z = params[labels[i]], k = ormOptions.zoneStrength;
        // Metal is binary per material in real PBR: snap to the zone value, keep only roughness micro-variation.
        p[q + 2] = z.metal * 255 * k + p[q + 2] * (1 - k) * (z.metal > .5 ? 1 : .2);
        const detail = (p[q + 1] - 128) * .35;
        // Colour-driven micro variation: darker albedo reads as worn/dirty, so slightly rougher.
        const lum = col ? (col[q] * .299 + col[q + 1] * .587 + col[q + 2] * .114) / 255 : .5;
        p[q + 1] = Math.max(0, Math.min(255, z.rough * 255 + detail * (1 - k * .5) + (.5 - lum) * 60 * ormOptions.wear));
        // Cavities collect grime: occluded texels get rougher.
        if (ao) p[q + 1] = Math.min(255, p[q + 1] + (255 - ao[q]) * .25 * (.4 + ormOptions.wear));
      }
      p[q + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    if (!record.ormTexture || record.ormTexture.image !== canvas) { record.ormTexture?.dispose(); record.ormTexture = canvasTexture(canvas, false); }
    record.ormTexture.needsUpdate = true;
    const m = record.material; m.aoMap = m.roughnessMap = m.metalnessMap = record.ormTexture; m.roughness = 1; m.metalness = 1; m.aoMapIntensity = 1; m.needsUpdate = true;
  }
  function capture() { renderer.render(scene, viewLock ? framedCamera(viewLock.camera) : camera); return renderer.domElement.toDataURL('image/png'); }
  // A size² RGBA canvas costs 4 bytes/px in CPU memory and again as a GPU texture (+1/3 for mipmaps).
  function memoryEstimate(size) {
    const layer = size * size * 4, uvCount = records.filter(r => r.uv).length || 1;
    return { perCanvasMB: Math.round(layer / 2 ** 20), bakePeakMB: Math.round((layer * 2.25 + layer * 2 * uvCount) / 2 ** 20), deviceGB: navigator.deviceMemory || null };
  }
  function ensureMemory(size, purpose) {
    const estimate = memoryEstimate(size);
    // navigator.deviceMemory is capped at 8 (GB) by browsers; only refuse when it reports clearly too little.
    if (size >= 8192 && estimate.deviceGB && estimate.deviceGB < 8) throw new Error(`本机报告内存约 ${estimate.deviceGB} GB，8K ${purpose === 'export' ? '导出' : '烘焙'}峰值约需 ${estimate.bakePeakMB} MB，容易失败。请改用 4K。`);
    return estimate;
  }
  function explainGPUError(error, size) {
    const gl = renderer.getContext();
    if (gl.isContextLost()) return new Error(`显卡上下文丢失，${size}×${size} 烘焙失败（通常是显存不足）。请先导出 GLB 保存，再刷新页面并改用较低尺寸。`);
    if (/memory|allocation|RangeError/i.test(`${error?.name} ${error?.message}`)) return new Error(`内存不足，${size}×${size} 处理失败。请关闭其他标签页，或改用 4K。`);
    return error;
  }
  renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); notify('显卡上下文丢失（通常是显存不足）。请导出 GLB 保存当前成果，然后刷新页面。', true); });
  async function exportTexture({ channel = selectedChannel, size = 4096 } = {}) {
    const usable = records.filter(r => r.uv);
    if (!usable.length) throw new Error('模型没有 UV。');
    checkBakeSize(renderer, size); ensureMemory(size, 'export');
    const sourceSizes = [];
    for (let i = 0; i < usable.length; i++) {
      const record = usable[i], canvas = canvasOf(size);
      const composed = (channel === 'orm' || channel === 'unityMS' || channel === 'unityAO') ? record.ormCanvas : channel === 'emissive' ? record.emissiveCanvas : channel === 'color' ? record.colorCanvas : record.normalCanvas;
      const hasLayers = (channel === 'orm' || channel === 'unityMS' || channel === 'unityAO') ? !!record.ormCanvas : (channel === 'color' && record.shadeCanvas && shadeOptions.on) || layers.some(l => l.channel === channel && l.visible && l.entries.some(e => e.key === record.key));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(`浏览器无法创建 ${size}×${size} 画布（内存不足），请改用较低尺寸。`);
      if (composed && hasLayers) { ctx.drawImage(composed, 0, 0, size, size); sourceSizes.push(composed.width); } else { if (channel === 'orm' || channel === 'unityMS' || channel === 'unityAO') drawORMBase(record, canvas); else drawOriginal(record, channel, canvas); sourceSizes.push(null); }
      if (channel === 'unityMS' || channel === 'unityAO') {
        const im = ctx.getImageData(0, 0, size, size), d = im.data;
        for (let k = 0; k < d.length; k += 4) { const ao = d[k], rough = d[k + 1], metal = d[k + 2];
          if (channel === 'unityMS') { d[k] = d[k + 1] = d[k + 2] = metal; d[k + 3] = 255 - rough; } else { d[k] = d[k + 1] = d[k + 2] = ao; d[k + 3] = 255; } }
        ctx.putImageData(im, 0, 0);
      }
      if (uvDown) flipCanvas(canvas);
      const saved = await saveCanvas(canvas, `${modelName}-${channel === 'emissive' ? 'Emissive' : channel === 'unityMS' ? 'MetallicSmoothness' : channel === 'unityAO' ? 'AO' : channel === 'orm' ? 'ORM' : channel === 'normal' ? 'Normal-OpenGL' : 'BaseColor'}-${usable.length > 1 ? `${i + 1}-` : ''}${size}.png`);
      canvas.width = canvas.height = 0;
      if (!saved) throw new Error(`${size}×${size} PNG 编码失败（通常是内存不足），请改用较低尺寸。`);
    }
    const smaller = sourceSizes.filter(v => v && v < size);
    notify(smaller.length ? `已导出 ${size}×${size} PNG；其中图层烘焙于 ${Math.max(...smaller)}×${Math.max(...smaller)}，导出时已放大，没有新增细节。` : `已导出 ${usable.length} 张 ${size} × ${size} PNG。`, !!smaller.length);
    return { size, sourceSizes };
  }
  async function exportGLB() {
    const mode = renderMode; setRender('MAT');
    try { const data = await new GLTFExporter().parseAsync(group, { binary: true, onlyVisible: false }); download(new Blob([data], { type: 'model/gltf-binary' }), `${modelName}-已贴图.glb`); notify('已导出包含颜色和法线贴图的 GLB。'); } finally { setRender(mode); }
  }
  // Start empty: the artist imports their own model.
  let ready = Promise.resolve();
  renderer.setAnimationLoop(() => {
    if (busy) return;
    if (viewLock) { renderer.render(scene, framedCamera(viewLock.camera)); return; }
    controls.update(); renderer.render(scene, camera);
  });
  return { ready, loadFile, setTexture, project, applyUV, generateNormal, setRender, setProjection, capture, captureForGeneration, getLayers, setLayer, deleteLayer, undo, redo, exportTexture, exportGLB, fitView,
    getModelShape: () => { if (!model) return null; const b = new THREE.Box3().setFromObject(group), sz = b.getSize(new THREE.Vector3());
      const tall = sz.y > Math.max(sz.x, sz.z) * 1.6;
      // Two lower columns: sample a horizontal slice at knee height and look for a central gap.
      let gap = false; if (tall) { const y = b.min.y + sz.y * .25, xs = [];
        for (const m of meshes) { const pos = m.geometry.attributes.position, v = new THREE.Vector3(); for (let i = 0; i < pos.count; i += 7) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); if (Math.abs(v.y - y) < sz.y * .02) xs.push(v.x); } }
        if (xs.length > 20) { const c = (b.min.x + b.max.x) / 2, w = sz.x * .04; gap = !xs.some(x => Math.abs(x - c) < w) && xs.some(x => x < c) && xs.some(x => x > c); } }
      return { humanoid: tall && gap }; },
    getUVConvention: () => uvDown ? 'gltf' : 'opengl', transferHires, smoothNormals, bakeAOMap, computeZones, getZones, setZone, highlightZone, uvMatchScore, bakeShapeShade, setShadeOptions, getUvSources, applyUvRefine, hasShade: () => records.some(r => r.shadeCanvas), setORMOptions, getORMOptions: () => ({ ...ormOptions }),
    lockView, unlockView, isViewLocked: () => !!viewLock, setCut, getCut: () => cut && { ...cut }, getParts, setPartVisible, soloPart, showAllParts, captureFaces, viewFrom, projectViews, faces: Object.keys(FACES), getFrameRect, memoryEstimate,
    getGpuLimits: () => gpuLimits(renderer),
    getCompositeSizes: () => records.map(r => ({ key: r.key, color: r.colorCanvas?.width || null, normal: r.normalCanvas?.width || null })),
    zoom: factor => { assertUnlocked(); if (camera.isOrthographicCamera) { camera.zoom /= factor; camera.updateProjectionMatrix(); } else camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target); },
    // Viewport lighting: rotate the key light to inspect normal detail, or switch it all off to see pure colour.
    setLight: ({ angle, height, intensity, unlit } = {}) => {
      if (angle != null || height != null) { const a = THREE.MathUtils.degToRad(angle ?? lightState.angle), h = height ?? lightState.height; lightState.angle = angle ?? lightState.angle; lightState.height = h;
        key.position.set(Math.sin(a) * 5, 1 + h * 5, Math.cos(a) * 5); }
      if (intensity != null) { lightState.intensity = intensity; key.intensity = 2.2 * intensity; fill.intensity = .8 * intensity; hemi.intensity = .6 * intensity; scene.environmentIntensity = .9 * intensity; }
      if (unlit != null) { lightState.unlit = unlit; renderer.toneMapping = unlit ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping; setRender(unlit ? 'FLA' : (renderMode === 'FLA' ? 'MAT' : renderMode)); }
      return { ...lightState };
    },
    setEnv: type => { key.color.set(type === 'warm' ? 0xffba7a : type === 'cool' ? 0xb6d8ff : 0xffeee2); fill.color.set(type === 'warm' ? 0xaa8899 : 0x9dbdff); },
    setEmissiveStrength: value => { emissiveStrength = value; records.forEach(r => { if (r.material.emissiveMap === r.emissiveTexture && r.emissiveTexture) r.material.emissiveIntensity = value; }); },
    hasEmissive: () => layers.some(l => l.channel === 'emissive' && l.visible),
    setNormalStrength: value => { normalStrength = value; records.forEach(r => r.material.normalScale?.set(value, value)); setRender(renderMode); },
    getModelInfo: () => ({ name: modelName, meshes: meshes.length, faces: meshes.reduce((n, m) => n + (m.geometry.index?.count || m.geometry.attributes.position.count) / 3, 0), uv: records.every(r => r.uv) }),
    getPending: () => pending,
    getDebug: () => ({ renderer, camera, controls, meshes, records, layers }),
  };
}
