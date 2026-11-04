// Automation bridge: exposes workbench operations as async functions that external programs can call.
// The page polls /api/automation/pending for commands, executes them, and POSTs the result back.
// This avoids WebSocket complexity and works with the existing HTTP server.

export function startAutomation({ scene, state, callScene, loadSource, toast, buildGenerationPrompt, buildUvRefinePrompt, currentModel }) {
  if (!scene || typeof scene.captureFaces !== 'function') return;

  const api = {
    async status() {
      return { model: state.modelLoaded, channel: state.channel, layers: scene.getLayers?.()?.length || 0, busy: state.busy };
    },

    async 'generate-six'({ channel = 'color', faces = ['front','back','left','right','top','bottom'], size = 4096 } = {}) {
      if (!state.modelLoaded) throw Error('请先导入模型。');
      if (!state.useServerConfig) throw Error('请先配置 API 密钥。');
      if (channel === 'color' && !state.reference) throw Error('请先上传参考图。');
      const model = currentModel();
      const snaps = scene.captureFaces(faces);
      const views = {};
      for (const sn of snaps) {
        const prompt = buildGenerationPrompt({ channel, view: sn.face });
        const body = { useServerConfig: true, model, prompt, size: `${size}x${size}`, mode: 'edits', image: sn.image, ...(state.reference ? { reference: state.reference } : {}) };
        const r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw Error(j.error?.message || j.error || `生成失败 ${r.status}`);
        views[sn.face] = { image: j.image, snapshot: sn, width: 0 };
        const img = new Image(); img.src = j.image; await img.decode(); views[sn.face].width = img.naturalWidth;
      }
      const viewList = Object.values(views).map(v => ({ image: v.image, snapshot: v.snapshot }));
      await scene.projectViews({ views: viewList, size, channel, normalSpace: 'view', name: `自动 · ${channel}` });
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
        for (let attempt = 0; attempt < 3; attempt++) {
          const r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const j = await r.json();
          if (r.ok) { results.push({ key: src.key, image: j.image }); break; }
          if ((r.status === 502 || r.status === 503) && attempt < 2) { await new Promise(q => setTimeout(q, 3000 * (attempt + 1))); continue; }
          throw Error(j.error?.message || j.error || `UV 细化失败 ${r.status}`);
        }
      }
      return scene.applyUvRefine({ results, channel, size });
    },

    async export({ channel = 'color', size = 4096 } = {}) {
      // Export to a data URL instead of downloading a file
      const usable = scene.getDebug().records.filter(r => r.uv);
      if (!usable.length) throw Error('模型没有 UV。');
      const canvases = [];
      for (const record of usable) {
        await scene.exportTexture({ channel, size }); // triggers the download; we also grab the canvas
      }
      return { channel, size, count: usable.length };
    },
  };

  // Expose to the page's global scope so external tools can call it
  window.__workbenchAuto = api;

  // Also expose via postMessage for cross-origin iframes or Electron wrappers
  window.addEventListener('message', async e => {
    if (!e.data?.workbench) return;
    const { id, method, params } = e.data.workbench;
    try {
      const fn = api[method]; if (!fn) throw Error(`未知方法: ${method}`);
      const result = await fn(params || {});
      window.parent.postMessage({ workbenchResult: { id, result } }, '*');
    } catch (error) {
      window.parent.postMessage({ workbenchResult: { id, error: error.message } }, '*');
    }
  });

  console.log('映纹工坊自动化接口已就绪。window.__workbenchAuto 可用。');
  return api;
}
