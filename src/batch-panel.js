import { prepareReplacement, applyReplacements, rollbackReplacements } from './batch-files.js';

export function mountBatchPanel({toast}) {
  const button=document.createElement('button');button.className='top-text-button';button.textContent='批量任务';document.querySelector('.top-actions').prepend(button);
  const dialog=document.createElement('dialog');dialog.style.cssText='width:min(1000px,94vw);max-height:90vh;overflow:auto;background:#151617;color:#eee;border:1px solid #555;border-radius:10px;padding:24px';
  dialog.innerHTML=`<header style="display:flex;justify-content:space-between"><h2>批量任务 · 项目贴图替换</h2><button data-close>关闭</button></header>
  <p>第一版：整理多模型任务清单，以及将已完成、已验收的新贴图批量写回项目。此页面暂不自动生成或自动评分，不消耗 API 额度。</p>
  <h3>① 模型任务清单</h3><input data-models type="file" multiple accept=".glb,.obj,.fbx"><p>清单仅记录文件名称和处理意图，不上传模型；不是生成执行队列。</p><div data-jobs></div><button data-save>下载任务清单</button>
  <h3>② 选择项目目录</h3><button data-project>选择允许写入的项目目录</button><span data-root></span>
  <p>只替换现有外部 PNG / JPG。保留文件路径和 Unity .meta，不修改材质引用。共享贴图会影响全部引用者，必须自行确认；不支持直接替换 GLB 内嵌贴图。</p>
  <h3>③ 添加一对新旧贴图</h3><label>原图相对路径 <input data-path placeholder="Assets/Textures/柱子_BaseColor.png" style="width:65%"></label><br><input data-candidate type="file" accept="image/png,image/jpeg"><button data-add>检查并加入替换清单</button>
  <p>逐对明确指定映射，不按相似文件名猜测。新旧格式必须相同；UV、通道含义和导入设置需人工确认。</p><div data-items></div>
  <h3>④ 确认备份与替换</h3><label><input data-approved type="checkbox"> 我已看过前后对比，确认 UV/通道对应、质量验收通过，并接受共享引用的影响</label><br>
  <button data-apply>选择备份目录并应用本批次</button><p>建议备份到项目外。全部原图备份完成后才写入；若中断，可能部分完成，使用下面的撤回功能恢复。外部软件仍可能同时写文件，操作时请暂停其他贴图编辑。</p>
  <button data-rollback>选择某次备份目录并撤回</button><pre data-status style="white-space:pre-wrap"></pre>`;
  document.body.append(dialog);button.onclick=()=>dialog.showModal();dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  const q=s=>dialog.querySelector(s);let root=null,items=[],jobs=[],busy=false;
  function status(message){q('[data-status]').textContent=message;}
  function download(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  function picker(){if(!window.showDirectoryPicker)throw Error('请用桌面 Chrome / Edge 打开，当前浏览器不支持授权目录写入。');return window.showDirectoryPicker({mode:'readwrite'});}
  q('[data-models]').onchange=e=>{jobs=[...e.target.files].map(file=>({name:file.name,bytes:file.size,task:'颜色优化',status:'待人工处理'}));const box=q('[data-jobs]');box.replaceChildren();for(const job of jobs){const row=document.createElement('p'),select=document.createElement('select');for(const name of ['颜色优化','法线细化','材质调整','重点区域补图']){const option=document.createElement('option');option.textContent=name;select.append(option);}select.onchange=()=>job.task=select.value;row.append(document.createTextNode(`${job.name} · `),select);box.append(row);}};
  q('[data-save]').onclick=()=>download({version:1,mode:'planning-only',jobs},'映纹批量任务清单.json');
  async function run(fn){if(busy)return;busy=true;for(const el of dialog.querySelectorAll('button,input,select'))el.disabled=true;try{await fn();}catch(e){status(e.message);toast(e.message,true);}finally{busy=false;for(const el of dialog.querySelectorAll('button,input,select'))el.disabled=false;}}
  q('[data-project]').onclick=()=>run(async()=>{const selected=await picker();if(items.length&&!confirm('切换目录会清空替换清单，继续？'))return;root=selected;items=[];q('[data-items]').replaceChildren();q('[data-approved]').checked=false;q('[data-root]').textContent=` 已选：${root.name}`;status('目录已授权。');});
  q('[data-add]').onclick=()=>run(async()=>{
    if(!root)throw Error('先选择项目目录。');const path=q('[data-path]').value.trim(),file=q('[data-candidate]').files[0];if(!file)throw Error('选择新贴图。');if(file.size>64*1024*1024)throw Error('新贴图请小于 64MB。');if(items.some(i=>i.path===path))throw Error('此路径已加入，请勿重复。');
    const item=await prepareReplacement(root,path,file);items.push(item);q('[data-approved]').checked=false;
    const row=document.createElement('p');row.textContent=`${path} ← ${file.name} · 原图 SHA-256 ${item.oldHash.slice(0,12)} · 新图 ${item.newHash.slice(0,12)}`;q('[data-items]').append(row);status(`待替换 ${items.length} 张，尚未写入原项目。`);
  });
  q('[data-apply]').onclick=()=>run(async()=>{
    if(!root||!items.length)throw Error('先添加替换项。');if(!q('[data-approved]').checked)throw Error('请先完成验收并勾选确认。');
    const backup=await picker();if(!confirm(`将覆盖 ${items.length} 张项目原贴图。备份保存到 ${backup.name}。确认执行？`))return;
    const result=await applyReplacements(root,backup,items);status(`替换完成并校验。备份批次：${result.id}。没有修改 .meta。`);items=[];q('[data-items]').replaceChildren();q('[data-approved]').checked=false;
  });
  q('[data-rollback]').onclick=()=>run(async()=>{
    if(!root)throw Error('先选择要恢复的项目目录。');const backup=await picker();if(!confirm('读取此备份记录，并恢复未被再次修改的对应贴图？'))return;const count=await rollbackReplacements(root,backup);status(`已恢复 ${count} 张贴图。`);
  });
}
