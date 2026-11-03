import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function readServerConfig(file = process.env.WORKBENCH_ENV_FILE || join(homedir(), 'Downloads', '.env')) {
  const values = {};
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '');
      values[match[1]] = value;
    }
  } catch { return { configured: false }; }
  const baseUrl = values.LUMINA_BASE_URL, apiKey = values.LUMINA_API_KEY;
  if (!baseUrl || !apiKey) return { configured: false };
  return { configured: true, baseUrl, apiKey, model: values.LUMINA_IMAGE_MODEL || values.IMAGE_MODEL || '', source: '下载目录 .env' };
}
