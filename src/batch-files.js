// Directory-handle scoped texture replacement. No server-side arbitrary paths.
export async function digest(blob) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
export function texturePath(path) {
  if(typeof path!=='string'||path.startsWith('/')||path.includes('\\')||path.split('/').some(x=>!x||x==='.'||x==='..')||! /\.(png|jpe?g)$/i.test(path)) throw Error('仅允许项目内的 PNG / JPG 相对路径。');
  return path;
}
async function fileHandle(root,path) {
  const parts=texturePath(path).split('/');let dir=root;
  for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);
  return dir.getFileHandle(parts.at(-1));
}
async function write(handle,blob) {const stream=await handle.createWritable();try{await stream.write(blob);await stream.close();}catch(e){try{await stream.abort();}catch{}throw e;}}
export async function prepareReplacement(root,path,replacement) {
  texturePath(path);
  const ext=name=>name.match(/\.(png|jpe?g)$/i)?.[1]?.toLowerCase().replace('jpeg','jpg');
  if(ext(path)!==ext(replacement.name))throw Error('新旧贴图格式必须一致，不能把 JPG 改名覆盖 PNG。');
  const handle=await fileHandle(root,path),before=await handle.getFile();
  return {path,oldHash:await digest(before),newHash:await digest(replacement),replacement};
}
// A separate backup folder is selected by the user, preferably outside Unity Assets.
export async function applyReplacements(root,backupRoot,items) {
  if(!items.length)throw Error('没有待替换贴图。');
  if(new Set(items.map(i=>i.path)).size!==items.length)throw Error('同一路径不能重复替换。');
  const handles=[];
  for(const item of items){const handle=await fileHandle(root,item.path),before=await handle.getFile();
    if(await digest(before)!==item.oldHash)throw Error(`原图已改变，停止替换：${item.path}`);
    if(await digest(item.replacement)!==item.newHash)throw Error('候选图片发生改变，请重新预演。');
    handles.push({handle,before});}
  const id=`yingwen-${crypto.randomUUID()}`,dir=await backupRoot.getDirectoryHandle(id,{create:true});
  const journal={version:1,id,created:new Date().toISOString(),status:'prepared',entries:items.map((i,n)=>({path:i.path,oldHash:i.oldHash,newHash:i.newHash,backup:`${n}.original`,state:'pending'}))};
  const journalFile=await dir.getFileHandle('journal.json',{create:true});
  const save=()=>write(journalFile,new Blob([JSON.stringify(journal,null,2)],{type:'application/json'}));
  // All original bytes and journal are durable before touching any source file.
  for(let n=0;n<items.length;n++)await write(await dir.getFileHandle(`${n}.original`,{create:true}),handles[n].before);
  await save();
  try{
    for(let n=0;n<items.length;n++){
      if(await digest(await handles[n].handle.getFile())!==items[n].oldHash)throw Error(`写入前检测到原图变化：${items[n].path}`);
      journal.entries[n].state='writing';await save();
      await write(handles[n].handle,items[n].replacement);
      if(await digest(await handles[n].handle.getFile())!==items[n].newHash)throw Error('写入后校验失败');
      journal.entries[n].state='applied';await save();
    }
    journal.status='applied';await save();return {id,journal};
  }catch(error){journal.status='interrupted';try{await save();}catch{}throw Error(`${error.message}。本批次可能部分完成，请用备份目录 ${id} 撤回；不要重复应用。`);}
}
export async function rollbackReplacements(root,dir) {
  const manifest=await dir.getFileHandle('journal.json');
  const journal=JSON.parse(await (await manifest.getFile()).text());
  if(journal.version!==1||!Array.isArray(journal.entries)||!journal.entries.length)throw Error('备份记录无效。');
  const jobs=[];
  for(let n=0;n<journal.entries.length;n++){
    const e=journal.entries[n];texturePath(e.path);
    if(e.backup!==`${n}.original`)throw Error('备份文件名无效。');
    const handle=await fileHandle(root,e.path),hash=await digest(await handle.getFile());
    const original=await (await dir.getFileHandle(e.backup)).getFile();
    if(await digest(original)!==e.oldHash)throw Error('备份损坏，停止撤回。');
    if(hash===e.oldHash)continue;
    if(hash!==e.newHash)throw Error(`贴图已被再次修改，不能覆盖：${e.path}`);
    jobs.push({handle,original,e});
  }
  for(const job of jobs){if(await digest(await job.handle.getFile())!==job.e.newHash)throw Error('撤回前文件已改变，停止。');await write(job.handle,job.original);if(await digest(await job.handle.getFile())!==job.e.oldHash)throw Error('撤回校验失败');}
  journal.status='rolled-back';await write(manifest,new Blob([JSON.stringify(journal,null,2)]));return jobs.length;
}
