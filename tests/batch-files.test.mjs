import test from 'node:test';
import assert from 'node:assert/strict';
import {texturePath,prepareReplacement,applyReplacements,rollbackReplacements} from '../src/batch-files.js';
function directory() {
  const files = new Map(), dirs = new Map();
  return {
    files, dirs,
    async getDirectoryHandle(n, o = {}) {
      if (!dirs.has(n)) { if (!o.create) throw Error('missing directory'); dirs.set(n, directory()); }
      return dirs.get(n);
    },
    async getFileHandle(n, o = {}) {
      if (!files.has(n)) { if (!o.create) throw Error('missing file'); files.set(n, new Blob([])); }
      return {
        async getFile() { return files.get(n); },
        async createWritable() {
          let blob;
          return {
            async write(b) { blob = b instanceof Blob ? b : new Blob([b]); },
            async close() { files.set(n, blob); },
            async abort() {},
          };
        },
      };
    },
  };
}
test('拒绝越界路径和非贴图',()=>{for(const p of ['../a.png','/a.png','a/../b.png','a\\b.png','a.meta','a//b.png'])assert.throws(()=>texturePath(p));assert.equal(texturePath('Assets/a.png'),'Assets/a.png');});
test('备份后替换并撤回，不碰meta',async()=>{const root=directory(),back=directory();root.files.set('a.png',new Blob(['old']));root.files.set('a.png.meta',new Blob(['GUID']));const item=await prepareReplacement(root,'a.png',new File(['new'],'new.png'));const result=await applyReplacements(root,back,[item]);assert.equal(await root.files.get('a.png').text(),'new');assert.equal(await root.files.get('a.png.meta').text(),'GUID');assert.equal(await rollbackReplacements(root,back.dirs.get(result.id)),1);assert.equal(await root.files.get('a.png').text(),'old');});
test('预演后原文件改变不覆盖',async()=>{const root=directory(),back=directory();root.files.set('a.png',new Blob(['old']));const item=await prepareReplacement(root,'a.png',new File(['new'],'new.png'));root.files.set('a.png',new Blob(['edited']));await assert.rejects(applyReplacements(root,back,[item]),/改变/);assert.equal(await root.files.get('a.png').text(),'edited');});
test('拒绝跨格式覆盖',async()=>{await assert.rejects(prepareReplacement(directory(),'a.png',new File(['x'],'x.jpg')),/格式/);});
test('撤回时保护后续编辑',async()=>{const root=directory(),back=directory();root.files.set('a.png',new Blob(['old']));const item=await prepareReplacement(root,'a.png',new File(['new'],'new.png'));const {id}=await applyReplacements(root,back,[item]);root.files.set('a.png',new Blob(['later']));await assert.rejects(rollbackReplacements(root,back.dirs.get(id)),/再次修改/);});
