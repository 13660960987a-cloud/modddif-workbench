import { evaluateReview, reviewTemplate, RUBRIC, REQUIRED_EVIDENCE, HARD_CHECKS } from './quality-review.js';

// Manual evidence collection and review, not an automatic vision expert.
export function mountQualityPanel({ scene, state, toast }) {
  const panel = document.createElement('section');
  panel.className = 'panel-section viewport-settings';
  panel.dataset.tab = 'tools';
  panel.innerHTML = `<details><summary class="section-title">美术验收 · 目标 9 分</summary>
    <p class="muted-note">人工辅助评分，不会自动看图。先保存成果并开始本轮，再转动/放大模型取证。刷新会丢失本轮，请下载记录。</p>
    <button class="secondary-button" data-action="new">开始新一轮验收</button>
    <p data-status>尚未开始</p>
    <div data-body hidden>
    <label class="field-label">取证类型<select data-kind>${REQUIRED_EVIDENCE.map(([k,l])=>`<option value="${k}">${l}</option>`).join('')}</select></label>
    <button class="secondary-button" data-action="capture">保存当前视图为证据</button>
    <label class="field-label">或上传证据图<input data-upload type="file" accept="image/png,image/jpeg,image/webp"></label>
    <p class="muted-note">正脸需完整露出关键结构；特写先放大。纯颜色请先切换“纯颜色”；材质图请统一灯光。系统不自动判断视角。</p>
    <div data-gallery></div>
    <label class="field-label">评审者姓名 / 标识<input data-reviewer placeholder="填写实际评审者"></label>
    ${RUBRIC.map(r=>`<details><summary>${r.label} · ${r.weight}%</summary><label class="field-label">分数（0–10）<input data-score="${r.key}" type="number" min="0" max="10" step="0.1"></label><textarea data-reason="${r.key}" rows="2" placeholder="具体依据与扣分原因"></textarea></details>`).join('')}
    ${HARD_CHECKS.map(([k,l])=>`<details><summary>${l}</summary><label><input type="checkbox" data-check="${k}"> 已检查且通过</label><textarea data-check-reason="${k}" rows="2" placeholder="检查依据；没检查就不要勾选"></textarea></details>`).join('')}
    <label><input data-no-major type="checkbox"> 已检查，没有明显或严重缺陷</label>
    <p class="muted-note">发现错位、重影或严重缺陷时不要勾选，先返修并重新取证。</p>
    <button class="secondary-button" data-action="evaluate">计算验收结果</button>
    <pre data-result style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit"></pre>
    <button class="secondary-button" data-action="download">下载本轮证据与评分 JSON</button>
    </div></details>`;
  document.querySelector('.right-panel').append(panel);
  const q = s => panel.querySelector(s);
  let revision = '', evidence = [], result = null, modelIdentity = '', baseline = '';
  const identity = () => scene.getDebug().meshes.map(m=>m.uuid).join('|');
  const signature = () => JSON.stringify(scene.getLayers?.() || [], (key,value)=> ['canvas','thumbnail','entries'].includes(key) ? undefined : value);
  function guard() {
    if (!revision) throw Error('请先开始新一轮验收。');
    if (state.busy) throw Error('正在处理贴图，请完成后再验收。');
    if (identity() !== modelIdentity || signature() !== baseline) throw Error('模型或图层已改变，请开始新一轮验收并重新取证。');
  }
  function gallery() {
    const root = q('[data-gallery]'); root.replaceChildren();
    for (const e of evidence) {
      const row = document.createElement('div'), img = new Image(), label = document.createElement('label'), check = document.createElement('input');
      img.src = e.image; img.alt = REQUIRED_EVIDENCE.find(([k])=>k===e.kind)[1]; img.style.cssText='display:block;max-width:100%;max-height:150px;object-fit:contain';
      check.type='checkbox'; check.checked=e.confirmed;
      check.onchange=()=>{e.confirmed=check.checked;invalidate();};
      label.append(check,document.createTextNode(` 已看图确认：${img.alt}`)); row.append(img,label);root.append(row);
    }
  }
  function invalidate(){result=null;q('[data-result]').textContent='证据或评分已更改，请重新计算。';}
  async function addImage(kind, image) {
    guard(); const version=revision;
    const img=new Image();img.src=image;await img.decode();guard();
    if(version!==revision) throw Error('本轮已切换，请重新取证。');
    evidence=evidence.filter(e=>e.kind!==kind);
    evidence.push({id:`${revision}-${kind}`,revision,kind,image,confirmed:false,width:img.naturalWidth,height:img.naturalHeight});
    gallery();invalidate();
  }
  function input() {
    const review=reviewTemplate(revision), ids=evidence.filter(e=>e.confirmed).map(e=>e.id);
    review.reviewer=q('[data-reviewer]').value.trim();review.reviewerType='human';
    for(const r of RUBRIC){const value=q(`[data-score="${r.key}"]`).value;review.scores[r.key]={score:value===''?null:Number(value),reason:q(`[data-reason="${r.key}"]`).value,evidenceIds:ids};}
    for(const [key] of HARD_CHECKS)review.checks[key]={pass:q(`[data-check="${key}"]`).checked,reason:q(`[data-check-reason="${key}"]`).value,evidenceIds:ids};
    review.issues=q('[data-no-major]').checked?[]:[{severity:'major',description:'尚未确认无明显或严重缺陷，需继续检查或返修',evidenceIds:ids}];
    return {revision,evidence,review};
  }
  panel.addEventListener('input',invalidate);
  q('[data-upload]').onchange=async e=>{
    try{const file=e.target.files[0];if(!file)return;if(file.size>20*1024*1024)throw Error('验收图片请小于 20MB。');const kind=q('[data-kind]').value;guard();const version=revision;
      const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(file);});
      if(version!==revision)throw Error('本轮已切换，请重新上传。');await addImage(kind,image);
    }catch(error){toast(error.message,true);}finally{e.target.value='';}
  };
  panel.addEventListener('click',async e=>{
    const action=e.target.dataset.action;if(!action)return;
    try{
      if(action==='new'){
        if(!state.modelLoaded||state.busy)throw Error('请先导入模型，并等待当前操作完成。');
        if(revision&&!confirm('开始新一轮会清除当前评分和证据，是否继续？'))return;
        revision=crypto.randomUUID();evidence=[];result=null;modelIdentity=identity();baseline=signature();
        for(const el of panel.querySelectorAll('textarea,input:not([type=file])')){el.value='';if(el.type==='checkbox')el.checked=false;}
        q('[data-body]').hidden=false;q('[data-status]').textContent=`本轮 ${revision.slice(0,8)} · 改贴图后需重新验收`;
        gallery();q('[data-result]').textContent='尚未评分';
      }else if(action==='capture'){
        guard();const kind=q('[data-kind]').value;
        if(kind==='reference'){if(!state.reference)throw Error('请先上传参考图。');await addImage(kind,state.reference);}
        else await addImage(kind,scene.capture());
      }else if(action==='evaluate'){
        guard();result=evaluateReview(input());q('[data-result]').textContent=`${result.status}\n总分：${result.score??'待评分'} / 10\n${result.reasons.join('\n')}\n\n仅校验人工填写的证据与分数，不代表系统已自动看图。材质改动也需主动开始新一轮。`;
      }else if(action==='download'){
        guard();const data=input();const blob=new Blob([JSON.stringify({...data,result:evaluateReview(data)},null,2)],{type:'application/json'});
        const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`美术验收-${revision.slice(0,8)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
      }
    }catch(error){toast(error.message,true);}
  });
}
