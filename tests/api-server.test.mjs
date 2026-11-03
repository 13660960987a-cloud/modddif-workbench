import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createProxyServer} from '../api-server.mjs';

const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image = `data:image/png;base64,${b64}`;
const origin = 'http://127.0.0.1:5173';
const defaults = {baseUrl: 'https://example.test/v1', apiKey: 'test-secret', model: 'my-image-model', prompt: '红色丝绸', size: '4096x4096'};
async function withServer(fetchImpl, action, options = {}) {
  const server = createProxyServer({fetchImpl, ...options});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {await action(`http://127.0.0.1:${server.address().port}`);}
  finally {await new Promise(resolve => server.close(resolve));}
}
function post(url, body, headers = {}) {
  return fetch(`${url}/api/generate`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin, ...headers}, body: JSON.stringify({...defaults, ...body})});
}

test('generation forwards exact requested 4K size and returns image data', async () => {
  let calls = 0;
  await withServer(async (url, init) => {
    calls++;
    assert.equal(url.href, 'https://example.test/v1/images/generations');
    assert.equal(init.headers.Authorization, 'Bearer test-secret');
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(JSON.parse(init.body), {model: 'my-image-model', prompt: '红色丝绸', size: '4096x4096', n: 1});
    return Response.json({data: [{b64_json: b64, revised_prompt: '重写描述'}]});
  }, async url => {
    const response = await post(url, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const json = await response.json();
    assert.equal(typeof json.timing.totalMs, 'number');
    delete json.timing;
    assert.deepEqual(json, {image, revisedPrompt: '重写描述', requestedSize: '4096x4096', mode: 'generations'});
    assert.equal(calls, 1);
  });
});

test('edit request uses multipart images and preserves prompt', async () => {
  await withServer(async (url, init) => {
    assert.equal(url.pathname, '/v1/images/edits');
    assert.ok(init.body instanceof FormData);
    assert.equal(init.headers['Content-Type'], undefined);
    assert.equal(init.body.get('prompt'), '红色丝绸');
    assert.equal(init.body.get('size'), '4096x4096');
    assert.equal(init.body.getAll('image[]').length, 2);
    assert.equal(init.body.getAll('image[]')[0].type, 'image/png');
    assert.equal(init.body.get('mask').type, 'image/png');
    return Response.json({data: [{b64_json: b64}]});
  }, async url => {
    const response = await post(url, {mode: 'edits', image, reference: image, mask: image});
    assert.equal(response.status, 200);
  });
});

test('root API URLs do not introduce duplicate path separators', async () => {
  await withServer(async (url) => {
    assert.equal(url.href, 'https://example.test/images/generations');
    return Response.json({data: [{b64_json: b64}]});
  }, async url => {
    const response = await post(url, {baseUrl: 'https://example.test/'});
    assert.equal(response.status, 200);
  });
});

test('returned URL download never receives API Authorization header', async () => {
  let calls = 0;
  await withServer(async (url, init) => {
    if (++calls === 1) return Response.json({data: [{url: 'https://images.example.test/output.png'}]});
    assert.equal(url.href, 'https://images.example.test/output.png');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, 'manual');
    return new Response(Buffer.from(b64, 'base64'), {headers: {'Content-Type': 'image/png'}});
  }, async url => {
    const response = await post(url, {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).image, image);
    assert.equal(calls, 2);
  });
});

test('foreign web origins are denied before upstream access', async () => {
  await withServer(async () => {throw Error('must not call upstream');}, async url => {
    const response = await post(url, {}, {Origin: 'https://evil.example'});
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const result = await response.json();
    assert.match(result.error, /无权/);
  });
});

test('API errors hide secret keys and never silently downscale 4K request', async () => {
  let calls = 0;
  await withServer(async () => {
    calls++;
    return Response.json({error: {message: 'size unsupported; key=test-secret'}}, {status: 400});
  }, async url => {
    const response = await post(url, {});
    const result = await response.json();
    assert.equal(response.status, 502);
    assert.match(result.error, /size unsupported/);
    assert.doesNotMatch(result.error, /test-secret/);
    assert.equal(calls, 1);
  });
});

test('API and image redirects are not followed', async () => {
  await withServer(async () => new Response(null, {status: 302, headers: {Location: 'https://other.example'}}), async url => {
    const response = await post(url, {});
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /重定向/);
  });
});

test('invalid image protocols, uploads and misleading reference mode fail clearly', async () => {
  await withServer(async () => Response.json({data: [{url: 'file:///etc/passwd'}]}), async url => {
    let response = await post(url, {});
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /协议/);
    response = await post(url, {image});
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /图生图/);
    response = await post(url, {mode: 'edits', image: 'data:image/png;base64,xxx'});
    assert.notEqual(response.status, 200);
  });
});

test('upstream timeout returns a Chinese actionable error', async () => {
  await withServer(async (_url, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), async url => {
    const response = await post(url, {});
    assert.equal(response.status, 504);
    assert.match((await response.json()).error, /超时/);
  }, {timeoutMs: 25});
});

test('server config exposes no secret and only forwards to configured destination', async () => {
  const configLoader=()=>({configured:true,baseUrl:'https://example.test/v1',apiKey:'server-private-key',model:'image-model',source:'下载目录 .env'});
  let calls=0;
  await withServer(async (url,init)=>{calls++;assert.equal(url.origin,'https://example.test');assert.equal(init.headers.Authorization,'Bearer server-private-key');return Response.json({data:[{b64_json:b64}]});},async url=>{
    const config=await (await fetch(url+'/api/config')).json();assert.equal(config.configured,true);assert.ok(!JSON.stringify(config).includes('private-key'));assert.equal(config.apiKey,undefined);
    let r=await post(url,{useServerConfig:true});assert.equal(r.status,200);
    r=await post(url,{useServerConfig:true,baseUrl:'https://evil.example/v1'});assert.equal(r.status,403);assert.equal(calls,1);
    r=await post(url,{useServerConfig:true},{Origin:''});assert.equal(r.status,403);
  },{configLoader});
});

test('model discovery returns image model identifiers without credentials',async()=>{
  const configLoader=()=>({configured:true,baseUrl:'https://example.test/v1',apiKey:'private',model:''});
  await withServer(async(url,init)=>{assert.equal(url.pathname,'/v1/models');assert.equal(init.headers.Authorization,'Bearer private');return Response.json({data:[{id:'gpt-image-1'},{id:'chat-model'},{id:'gemini-image'},{id:'doubao-seedream-5-0-260128'}]});},async url=>{
    const r=await fetch(url+'/api/models');assert.deepEqual(await r.json(),{models:['gpt-image-1','gemini-image','doubao-seedream-5-0-260128']});
  },{configLoader});
});

test('gateway timing and retry headers are reported; no imageConfig is invented', async () => {
  await withServer(async (url, init) => {
    assert.equal(init.body.get('imageConfig'), null);
    return new Response(JSON.stringify({data: [{b64_json: b64}]}), {headers: {'content-type': 'application/json', 'x-litellm-response-duration-ms': '1234.5', 'x-litellm-attempted-retries': '0'}});
  }, async url => {
    const r = await post(url, {mode: 'edits', image, model: 'gemini-3-pro-image-preview', baseUrl: 'https://lumina.tripo3d.com/v1'});
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.timing.upstreamMs, 1235);
    assert.equal(j.timing.retries, 0);
  });
});

test('closing the browser request aborts the upstream generation exactly once', async () => {
  let calls = 0, upstreamAborted;
  const aborted = new Promise(resolve => { upstreamAborted = resolve; });
  await withServer(async (url, init) => {
    calls++;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => { upstreamAborted(); reject(new Error('aborted')); }));
  }, async url => {
    const controller = new AbortController();
    const pending = fetch(`${url}/api/generate`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin}, body: JSON.stringify(defaults), signal: controller.signal}).catch(e => e);
    await new Promise(r => setTimeout(r, 80));
    controller.abort();
    await pending;
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream not aborted')), 2000))]);
    assert.equal(calls, 1);
  });
});
