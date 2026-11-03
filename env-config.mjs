import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

// Where a colleague's own key is kept after they enter it once in the app.
// Readable only by that user (0600); never sent to the browser.
export function userConfigFile() {
  if (process.env.WORKBENCH_CONFIG_FILE) return process.env.WORKBENCH_CONFIG_FILE;
  const os = platform();
  const base = os === 'win32' ? (process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'))
    : os === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
  return join(base, 'YingwenWorkbench', 'api.env');
}

function parse(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

/**
 * Order: WORKBENCH_ENV_FILE (explicit) → key saved in the app → ~/Downloads/.env (developer setup).
 */
export function readServerConfig(file = process.env.WORKBENCH_ENV_FILE) {
  const candidates = file ? [[file, '指定的配置文件']] : [[userConfigFile(), '本机已保存'], [join(homedir(), 'Downloads', '.env'), '下载目录 .env']];
  for (const [path, source] of candidates) {
    const values = parse(path);
    if (!values) continue;
    const baseUrl = values.LUMINA_BASE_URL, apiKey = values.LUMINA_API_KEY;
    if (baseUrl && apiKey) return { configured: true, baseUrl, apiKey, model: values.LUMINA_IMAGE_MODEL || values.IMAGE_MODEL || '', source };
  }
  return { configured: false };
}

export function saveUserConfig({ baseUrl, apiKey }) {
  if (typeof baseUrl !== 'string' || typeof apiKey !== 'string') throw new Error('地址和密钥格式不正确。');
  // One token per line keeps the file parseable; reject anything that could inject another line.
  if (/[\s"'#]/.test(apiKey) || !apiKey || apiKey.length > 4096) throw new Error('密钥格式不正确。');
  if (/[\s"'#]/.test(baseUrl)) throw new Error('接口地址格式不正确。');
  const file = userConfigFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `LUMINA_BASE_URL=${baseUrl}\nLUMINA_API_KEY=${apiKey}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  return file;
}

export function clearUserConfig() {
  rmSync(userConfigFile(), { force: true });
}
