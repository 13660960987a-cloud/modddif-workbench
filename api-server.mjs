import http from 'node:http';
import { readServerConfig, saveUserConfig, clearUserConfig } from './env-config.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';

const MAX_REQUEST = 96 * 1024 * 1024;
const MAX_IMAGE = 64 * 1024 * 1024;
const DEFAULT_ORIGINS = [5173, 5174, 4173, 8787, 17860].flatMap(port => ['localhost', '127.0.0.1'].map(host => `http://${host}:${port}`));
class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function readLimited(stream, limit, label) {
  const declared = Number(stream.headers?.get?.('content-length') ?? stream.headers?.['content-length'] ?? 0);
  if (declared > limit) throw new ApiError(`${label}过大，请使用较小的图片。`, 413);
  const chunks = [];
  let count = 0;
  for await (const chunk of stream.body || stream) {
    count += chunk.length;
    if (count > limit) throw new ApiError(`${label}过大，请使用较小的图片。`, 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new ApiError('接口返回的内容不是有效的 PNG、JPEG 或 WebP 图片。', 502);
}

function decodeBase64(value, label = '图片') {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_IMAGE / 3) * 4 || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(value)) {
    throw new ApiError(`${label}的 Base64 数据无效或超过 64 MB。`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE) throw new ApiError(`${label}过大或为空。`, 413);
  return {bytes, type: imageType(bytes)};
}

function decodeDataUrl(value, label) {
  const match = typeof value === 'string' && value.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,([\s\S]+)$/i);
  if (!match) throw new ApiError(`${label}必须是 PNG、JPEG 或 WebP 图片。`);
  return decodeBase64(match[1], label);
}

function normalizeBaseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new ApiError('请填写完整的 API 地址，例如 https://你的服务/v1。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ApiError('API 地址仅支持 HTTP(S)，请去掉地址中的账号、查询参数和片段。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/images\/(?:generations|edits)$/, '');
  return url;
}

function redact(message, apiKey) {
  let result = String(message);
  if (apiKey) result = result.split(apiKey).join('[密钥已隐藏]');
  return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').slice(0, 1200);
}

async function generate(body, {fetchImpl, timeoutMs, signal}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('请求数据格式不正确。');
  const {baseUrl, apiKey = '', model, prompt, mode = 'generations', size = '4096x4096'} = body;
  if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new ApiError('API 密钥格式不正确。');
  if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new ApiError('请填写模型名称。');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new ApiError('请填写生成描述（最多 32000 字符）。');
  if (!['generations', 'edits'].includes(mode)) throw new ApiError('不支持的生成模式。');
  if (typeof size !== 'string' || !(size === 'auto' || /^\d{2,5}x\d{2,5}$/.test(size))) throw new ApiError('图片尺寸格式应为 4096x4096。');
  const base = normalizeBaseUrl(baseUrl);
  const endpoint = new URL(base);
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + `/images/${mode}`;
  const headers = apiKey ? {Authorization: `Bearer ${apiKey}`} : {};
  const params = {model: model.trim(), prompt: prompt.trim(), size, n: 1};
  // Measured 2026-11-02: Lumina's LiteLLM proxy drops imageConfig (drop_params) and its Gemini routes
  // return 1024×1024 regardless, so no unverified extra parameters are sent.
  for (const key of ['quality', 'background', 'output_format', 'response_format']) {
    if (body[key] != null) {
      if (typeof body[key] !== 'string' || body[key].length > 64) throw new ApiError(`参数 ${key} 格式不正确。`);
      params[key] = body[key];
    }
  }
  let payload;
  if (mode === 'edits') {
    const primary = decodeDataUrl(body.image || body.reference, '编辑用图片');
    payload = new FormData();
    Object.entries(params).forEach(([key, value]) => payload.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value)));
    const extension = primary.type.split('/')[1];
    const reference = body.image && body.reference ? decodeDataUrl(body.reference, '参考图片') : null;
    const field = reference ? 'image[]' : 'image';
    payload.append(field, new Blob([primary.bytes], {type: primary.type}), `viewport.${extension}`);
    if (reference) payload.append(field, new Blob([reference.bytes], {type: reference.type}), `reference.${reference.type.split('/')[1]}`);
    if (body.mask) {
      const mask = decodeDataUrl(body.mask, '遮罩图片');
      if (mask.type !== 'image/png') throw new ApiError('编辑遮罩必须是 PNG 图片。');
      payload.append('mask', new Blob([mask.bytes], {type: mask.type}), 'mask.png');
    }
  } else {
    if (body.image || body.reference || body.mask) throw new ApiError('文生图模式不发送参考图片；使用参考图片请切换到图生图模式。');
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(params);
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref?.();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, {once: true});
  const started = Date.now();
  try {
    const upstream = await fetchImpl(endpoint, {method: 'POST', headers, body: payload, redirect: 'manual', signal: controller.signal});
    if (upstream.status >= 300 && upstream.status < 400) throw new ApiError('API 返回了重定向；请把 API 地址改成服务商提供的最终地址。', 502);
    const raw = await readLimited(upstream, MAX_REQUEST, 'API 返回内容');
    let result;
    try { result = JSON.parse(raw.toString('utf8')); } catch {
      throw new ApiError(`API 返回了非 JSON 内容（HTTP ${upstream.status}）。请检查 API 地址和图片接口路径。`, 502);
    }
    if (!upstream.ok || result.error) {
      const details = redact(result.error?.message || result.message || result.error || '服务商没有提供错误详情', apiKey);
      throw new ApiError(`图片接口失败（HTTP ${upstream.status}）：${details}`, upstream.status === 429 ? 429 : 502);
    }
    const item = result.data?.[0];
    let image;
    if (item?.b64_json) {
      image = decodeBase64(item.b64_json, 'API 返回图片');
    } else if (item?.url) {
      let imageUrl;
      try { imageUrl = new URL(item.url); } catch { throw new ApiError('接口返回的图片地址无效。', 502); }
      if (!['http:', 'https:'].includes(imageUrl.protocol) || imageUrl.username || imageUrl.password) throw new ApiError('接口返回的图片地址协议不受支持。', 502);
      // Deliberately do not forward the user's Authorization header to returned image URLs.
      const download = await fetchImpl(imageUrl, {redirect: 'manual', signal: controller.signal, headers: {Accept: 'image/png,image/jpeg,image/webp'}});
      if (download.status >= 300 && download.status < 400) throw new ApiError('返回的图片地址需要重定向，请让服务商返回图片 Base64 或直接下载地址。', 502);
      if (!download.ok) throw new ApiError(`下载生成图片失败（HTTP ${download.status}）。`, 502);
      const bytes = await readLimited(download, MAX_IMAGE, '生成图片');
      image = {bytes, type: imageType(bytes)};
    } else throw new ApiError('接口响应中没有 data[0].b64_json 或 data[0].url 图片。', 502);
    const upstreamHeader = upstream.headers?.get?.('x-litellm-response-duration-ms');
    const upstreamMs = upstreamHeader ? Number(upstreamHeader) : NaN;
    const retries = upstream.headers?.get?.('x-litellm-attempted-retries');
    return {image: `data:${image.type};base64,${image.bytes.toString('base64')}`, revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined, requestedSize: size, mode,
      timing: {totalMs: Date.now() - started, ...(Number.isFinite(upstreamMs) ? {upstreamMs: Math.round(upstreamMs)} : {}), ...(retries != null ? {retries: Number(retries)} : {})}};
  } catch (error) {
    if (timedOut) throw new ApiError(`图片生成超时（${Math.round(timeoutMs / 1000)} 秒）。请稍后重试。`, 504);
    if (controller.signal.aborted) throw new ApiError('生成已取消。', 499);
    if (error instanceof ApiError) throw error;
    throw new ApiError(`无法连接图片接口：${redact(error.message, apiKey)}。请检查地址和网络。`, 502);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };

// Serves the built page from `root` (the installer's app folder) so one process is the whole app.
async function serveStatic(root, request, response) {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403); return response.end(); }
  try {
    const info = await stat(file); if (!info.isFile()) throw new Error();
    response.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(await readFile(file));
  } catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('未找到'); }
}

export function createProxyServer({allowedOrigins = DEFAULT_ORIGINS, timeoutMs = 240000, fetchImpl = fetch, configLoader = readServerConfig, staticRoot = null, saveConfig = saveUserConfig, clearConfig = clearUserConfig} = {}) {
  const origins = new Set(allowedOrigins);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
      response.end(JSON.stringify(data));
    };
    try {
      if (staticRoot && !request.url.startsWith('/api/') && (request.method === 'GET' || request.method === 'HEAD')) {
        response.removeHeader('Cache-Control'); return serveStatic(staticRoot, request, response);
      }
      const host = request.headers.host || '';
      if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) throw new ApiError('代理仅允许本机地址访问。', 403);
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) throw new ApiError('当前网页无权访问本地图片代理。', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('禁止跨站点访问本地图片代理。', 403);
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        if (!origin) throw new ApiError('缺少请求来源。', 403);
        response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Workbench-Client');
        response.writeHead(204);
        return response.end();
      }
      if (request.url === '/api/models' && request.method === 'GET') {
        const config = configLoader();
        if (!config.configured) throw new ApiError('请先配置下载目录 .env 中的图片接口。');
        const endpoint = normalizeBaseUrl(config.baseUrl); endpoint.pathname += '/models';
        const response = await fetchImpl(endpoint, {headers:{Authorization:`Bearer ${config.apiKey}`},redirect:'manual',signal:AbortSignal.timeout(25000)});
        if (!response.ok) throw new ApiError(`无法读取模型列表（HTTP ${response.status}）。可以手动输入模型名称。`,502);
        const raw = await readLimited(response, 2 * 1024 * 1024, '模型列表');
        let result; try {result=JSON.parse(raw.toString('utf8'));}catch {throw new ApiError('模型列表不是 JSON。',502);}
        const models=(result.data||[]).map(item=>item.id).filter(id=>typeof id==='string'&&/image|banana|flux|dall|seedream|wan2|midjourney|kontext/i.test(id));
        return send(200,{models});
      }
      if (request.url === '/api/config'  && request.method === 'GET') {
        const config = configLoader();
        return send(200, {configured:!!config.configured,baseUrl:config.baseUrl,model:config.model,source:config.source});
      }
      // Saving or clearing a key changes state on disk: only the workbench page itself may do it.
      if (request.url === '/api/config' && (request.method === 'POST' || request.method === 'DELETE')) {
        if (!origin || !origins.has(origin)) throw new ApiError('只能在工作台页面里修改密钥。', 403);
        if (request.method === 'DELETE') { clearConfig(); return send(200, {ok: true}); }
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new ApiError('请求必须使用 JSON 格式。', 415);
        let body; try { body = JSON.parse((await readLimited(request, 16 * 1024, '配置')).toString('utf8')); } catch (e) { if (e instanceof ApiError) throw e; throw new ApiError('配置格式无效。'); }
        const base = normalizeBaseUrl(String(body.baseUrl || ''));
        try { saveConfig({baseUrl: base.href.replace(/\/$/, ''), apiKey: String(body.apiKey || '').trim()}); } catch (e) { throw new ApiError(e.message); }
        const config = configLoader();
        return send(200, {configured: !!config.configured, baseUrl: config.baseUrl, source: config.source});
      }
      if (request.url === '/api/health' && request.method === 'GET') return send(200, {ok: true, service: '本地图片代理'});
      // ── Automation API: lets other programs (AI agents, scripts, Blender add-ons) drive the workbench ──
      if (request.url === '/api/automation/guide' && request.method === 'GET') {
        // AI agents read this first to learn how to drive the workbench.
        const { GUIDE } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'src', 'ai-guide.js')).href);
        response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return response.end(GUIDE);
      }
      if (request.url === '/api/automation' && request.method === 'GET') {
        return send(200, {
          service: '映纹工坊 自动化接口',
          version: '1.5.0',
          endpoints: {
            'GET /api/health': '服务状态',
            'GET /api/config': '接口配置（不含密钥）',
            'POST /api/config': '保存 API 密钥到本机',
            'GET /api/models': '可用的图片模型列表',
            'POST /api/generate': '调用图片模型生成（edits / generations）',
            'GET /api/automation': '本文档',
            'POST /api/automation/generate-six': '一键六面生成并投射（需要 page 运行中）',
            'POST /api/automation/project': '投射待处理图片到 UV',
            'POST /api/automation/export': '导出贴图（返回 base64）',
            'POST /api/automation/shade': '按模型形状加明暗',
            'POST /api/automation/zones': '按颜色分材质',
            'POST /api/automation/ao': '烘焙 AO',
            'POST /api/automation/uv-refine': 'UV 细化',
          },
          note: '自动化接口通过浏览器页面的 window.__workbench 控制工作台。页面必须打开且已导入模型。所有 POST 都用 JSON，返回 JSON。',
        });
      }
      if (request.url !== '/api/generate') return send(404, {error: '接口不存在。'});
      if (request.method !== 'POST') return send(405, {error: '请使用 POST 请求。'});
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new ApiError('请求必须使用 JSON 格式。', 415);
      const raw = await readLimited(request, MAX_REQUEST, '请求图片');
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { throw new ApiError('请求 JSON 格式无效。'); }
      if (body.useServerConfig) {
        if (!origin || !origins.has(origin)) throw new ApiError('本地密钥调用需要工作台页面的来源验证。', 403);
        const config = configLoader();
        if (!config.configured) throw new ApiError('下载目录 .env 中没有可用的 LUMINA 配置。');
        if (body.baseUrl && normalizeBaseUrl(body.baseUrl).href !== normalizeBaseUrl(config.baseUrl).href) throw new ApiError('本地密钥只能发送到 .env 配置的服务地址。', 403);
        body = {...body, baseUrl:config.baseUrl, apiKey:config.apiKey, model:body.model || config.model};
      }
      // A cancelled browser request closes the socket; abort upstream so no unseen generation keeps running here.
      const clientGone = new AbortController();
      response.on('close', () => { if (!response.writableEnded) clientGone.abort(); });
      const result = await generate(body, {fetchImpl, timeoutMs, signal: clientGone.signal});
      send(200, result);
    } catch (error) { send(error.status || 500, {error: error instanceof ApiError ? error.message : '本地代理处理失败，请重试。'}); }
  });
  server.requestTimeout = timeoutMs + 30000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.WORKBENCH_API_PORT || 8787);
  const allowedOrigins = process.env.WORKBENCH_ALLOWED_ORIGINS ? process.env.WORKBENCH_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean) : DEFAULT_ORIGINS;
  const staticRoot = process.env.WORKBENCH_STATIC_ROOT ? normalize(process.env.WORKBENCH_STATIC_ROOT) : null;
  const server = createProxyServer({allowedOrigins, staticRoot});
  server.on('error', error => { console.error(`本地图片代理启动失败：${error.code || '未知错误'}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`本地图片代理已启动：http://127.0.0.1:${port}`));
}
