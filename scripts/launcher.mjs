// Packaged-app entry: serves the built page and the API from one local port, then opens the browser.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = existsSync(join(here, 'web', 'index.html')) ? here : join(here, '..');
const staticRoot = join(appRoot, 'web');

// First free port from a fixed range, so the page origin stays the same between launches.
function freePort(start, end) {
  return new Promise((resolve, reject) => {
    const tryPort = port => {
      if (port > end) return reject(new Error('没有可用端口（17860–17879 都被占用）。'));
      const probe = createServer().once('error', () => tryPort(port + 1)).once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

function openBrowser(url) {
  const os = platform();
  const [cmd, args] = os === 'darwin' ? ['open', [url]] : os === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

const port = await freePort(17860, 17879);
const origin = `http://127.0.0.1:${port}`;
process.env.WORKBENCH_STATIC_ROOT = staticRoot;
process.env.WORKBENCH_API_PORT = String(port);
process.env.WORKBENCH_ALLOWED_ORIGINS = `${origin},http://localhost:${port}`;
const { createProxyServer } = await import(pathToFileURL(join(appRoot, 'api-server.mjs')).href);
const server = createProxyServer({ allowedOrigins: process.env.WORKBENCH_ALLOWED_ORIGINS.split(','), staticRoot });
server.listen(port, '127.0.0.1', () => {
  console.log(`映纹工坊已启动：${origin}`);
  console.log('关闭这个窗口即可退出。');
  if (!process.env.WORKBENCH_NO_BROWSER) openBrowser(origin);
});
// The page pings /api/health on load and every 20 s; any request counts as activity.
// Quits 3 min after the last tab closes (10 min if no page ever opened), so a Mac .app never lingers.
let lastSeen = Date.now(), seenPage = false;
server.on('request', request => { lastSeen = Date.now(); if (request.url === '/api/health') seenPage = true; });
setInterval(() => {
  if (Date.now() - lastSeen > (seenPage ? 180000 : 600000)) { console.log('网页已关闭，映纹工坊退出。'); process.exit(0); }
}, 15000).unref();
server.on('error', error => { console.error(`启动失败：${error.message}`); process.exit(1); });
