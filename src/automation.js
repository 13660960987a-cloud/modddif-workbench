// Automation bridge: exposes workbench operations as async functions that external programs can call.
import { evaluateReview, reviewTemplate } from './quality-review.js';
// Browser-callable bridge; no HTTP command queue is implemented.

export function startAutomation({ scene, state, callScene, loadSource, toast, buildGenerationPrompt, buildUvRefinePrompt, currentModel, autoMatte, prepareNormal }) {
  if (!scene || typeof scene.captureFaces !== 'function') return;
  let activeTask = null;
  let taskSeq = 0;
  const task = async (kind, fn) => {
    if (activeTask || state.busy) throw Error('已有任务进行中，请等待完成后再调用。');
    state.busy = true;
    const current = activeTask = { id: `wb-${Date.now()}-${++taskSeq}`, kind, started: new Date().toISOString() };
    try { return await fn(current); }
    finally { if (activeTask === current) activeTask = null; state.busy = false; }
  };
  const capabilities = {
    guide: '/api/automation/guide', interface: 'window.__workbenchAuto', version: '1.6.2',
    localOnly: true, paidOperations: ['generate-six', 'uv-refine'],
    localOperations: ['status', 'review-template', 'review-evaluate', 'capture-evidence', 'shade', 'ao', 'zones', 'export'],
    unsupported: ['HTTP automation queue', 'automatic vision scoring', 'automatic batch generation', 'direct GLB embedded-texture replacement'],
    requiresHumanReview: ['front-face confirmation', 'closeup detail', 'side consistency', 'replacement approval'],
  };
  const api = {
    async capabilities() { return structuredClone(capabilities); },
    async 'capture-evidence'() {
      if (!state.modelLoaded || state.busy) throw Error('请先导入模型并等待当前任务结束。');
      return { image: scene.capture(), confirmed: false, note: '当前视口截图；必须实际看图判断视角，不能自动视为正脸。' };
    },
    async 'review-template'({ revision } = {}) {
      if (typeof revision !== 'string' || !revision.trim()) throw Error('请提供本次成果的唯一版本标识。');
      return reviewTemplate(revision);
    },
    async 'review-evaluate'(input = {}) {
      return evaluateReview(input);
    },
    async status() {
      return { model: state.modelLoaded, channel: state.channel, layers: scene.getLayers?.()?.length || 0, busy: state.busy || !!activeTask, task: activeTask ? { ...activeTask } : null, guide: capabilities.guide, next: state.modelLoaded ? '先取证并验收，或明确授权付费任务。' : '先导入带 UV 模型。' };
    },

    async 'generate-six'({ channel = 'color', faces = ['front','back','left','right','top','bottom'], size = 4096 } = {}) {
      if (!state.modelLoaded) throw Error('请先导入模型。');
      if (!state.useServerConfig) throw Error('请先配置 API 密钥。');
      if (channel === 'color' && !state.reference) throw Error('请先上传参考图。');
      if (!['color','normal','emissive'].includes(channel)) throw Error('不支持此生成通道。');
      if (![1024,2048,4096,8192].includes(size)) throw Error('无效的烘焙尺寸。');
      if (!Array.isArray(faces) || !faces.length || new Set(faces).size !== faces.length || faces.some(f=>!['front','back','left','right','top','bottom'].includes(f))) throw Error('视角列表无效。');
      if (typeof autoMatte !== 'function' || typeof prepareNormal !== 'function') throw Error('图像处理流程尚未连接。');
      const model = currentModel();
      const snaps = scene.captureFaces(faces);
      const views = {};
      for (const sn of snaps) {
        const prompt = buildGenerationPrompt({ channel, view: sn.face });
        const body = { useServerConfig: true, model, prompt, size: `${size}x${size}`, mode: 'edits', image: sn.image, ...(state.reference ? { reference: state.reference } : {}) };
        const r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw Error(j.error?.message || j.error || `生成失败 ${r.status}`);
        const processed = channel === 'normal' ? await prepareNormal(j.image, sn) : await autoMatte(j.image, sn, channel);
        views[sn.face] = { image: processed.image, snapshot: sn, width: 0, space: processed.space || 'view' };
        const img = new Image(); img.src = j.image; await img.decode(); views[sn.face].width = img.naturalWidth;
      }
      const viewList = Object.values(views).map(v => ({ image: v.image, snapshot: v.snapshot, normalSpace: v.space }));
      await scene.projectViews({ views: viewList, size, channel, normalSpace: channel === 'normal' ? 'tangent' : 'view', normalBlend: channel === 'normal' && Object.values(views).every(v => v.space === 'tangent'), name: `自动 · ${channel}` });
      return { faces: Object.keys(views), sizes: Object.values(views).map(v => v.width) };
    },

    async shade({ size = 4096 } = {}) { return scene.bakeShapeShade({ size }); },
    async ao({ size = 4096, samples = 96 } = {}) { return scene.bakeAOMap({ size, samples }); },
    async zones({ count = 6 } = {}) { return scene.computeZones({ count }); },

    async 'uv-refine'({ channel = 'color', size = 4096 } = {}) {
      if (!state.useServerConfig) throw Error('请先配置 API 密钥。');
      const model = currentModel();
      const sources = scene.getUvSources({ channel, size: 2048 });
      const results = [];
      for (const src of sources) {
        const body = { useServerConfig: true, model, prompt: buildUvRefinePrompt(), size: `${size}x${size}`, mode: 'edits', image: src.image, ...(state.reference ? { reference: state.reference } : {}) };
        const r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw Error(`UV 请求失败（${r.status}）；未自动重试，请先确认上游任务。`);
        results.push({ key: src.key, image: j.image });
      }
      return scene.applyUvRefine({ results, channel, size });
    },

    async export({ channel = 'color', size = 4096 } = {}) {
      // Export to a data URL instead of downloading a file
      const usable = scene.getDebug().records.filter(r => r.uv);
      if (!usable.length) throw Error('模型没有 UV。');
      await scene.exportTexture({ channel, size }); // one call exports all materials
      return { channel, size, count: usable.length, delivery: 'browser-download' };
    },
  };
  for (const name of ['generate-six', 'uv-refine', 'shade', 'ao', 'zones', 'export']) {
    const original = api[name];
    api[name] = params => task(name, () => original(params));
  }

  // Expose to the page's global scope so external tools can call it
  window.__workbenchAuto = api;

  // Also expose via postMessage for cross-origin iframes or Electron wrappers
  window.addEventListener('message', async e => {
    if (e.source !== window || e.origin !== window.location.origin || !e.data?.workbench) return;
    const { id, method, params } = e.data.workbench;
    try {
      const fn = Object.hasOwn(api, method) ? api[method] : null; if (typeof fn !== 'function') throw Error(`未知方法: ${method}`);
      const result = await fn(params || {});
      window.postMessage({ workbenchResult: { id, result } }, window.location.origin);
    } catch (error) {
      window.postMessage({ workbenchResult: { id, error: error.message } }, window.location.origin);
    }
  });

  console.log('映纹工坊自动化接口已就绪。window.__workbenchAuto 可用。');
  return api;
}
