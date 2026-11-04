import test from 'node:test';
import assert from 'node:assert/strict';

test('automation discovery endpoint returns method list', async () => {
  const { createProxyServer } = await import('../api-server.mjs');
  const { once } = await import('node:events');
  const server = createProxyServer({ fetchImpl: async () => { throw new Error('no upstream'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/automation`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.service, '映纹工坊 自动化接口');
    assert.ok(j.endpoints['GET /api/automation/guide']);
    assert.equal(j.endpoints['POST /api/automation/generate-six'], undefined);
    const guide = await fetch(`http://127.0.0.1:${server.address().port}/api/automation/guide`);
    assert.equal(guide.status, 200);
    assert.match(await guide.text(), /review-evaluate/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
