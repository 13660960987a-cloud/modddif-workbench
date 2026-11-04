// Node-only building blocks. No automatic retry, no automatic paid execution.
export function decideP2Plan({asset='未命名资产',closeup=false,needsParts=false,needsQuadEdit=false,faceLimit}={}) {
  for(const v of [closeup,needsParts,needsQuadEdit])if(typeof v!=='boolean')throw Error('决策选项必须为布尔值。');
  const quad=needsQuadEdit, limit=faceLimit??(closeup?(quad?22000:40000):(quad?10000:16000));
  validateFaces(limit,quad);
  return {schemaVersion:1,mode:'dry-run',asset,model:'P2-20260801',faceLimit:limit,generation:{quad,texture:true,pbr:true},parts:{required:needsParts,route:needsParts?'postprocess-segment':'none',schemaVerified:false},smartUV:{enabled:true,bake:true,maxEquivalentTriangles:80000},approvalRequired:true,costCredits:null,status:'未提交',reason:quad?'明确需要四边面编辑':closeup?'特写优先增加几何预算':'普通静态资产的保守三角面预算'};
}
function validateFaces(n,quad){if(!Number.isInteger(n)||n<48||n>(quad?25000:50000))throw Error('面数超出 P2 对应拓扑范围。');}
export function createTripoClient({apiKey,baseUrl='https://openapi.tripo3d.com/v3',fetchImpl=globalThis.fetch}={}) {
  if(typeof apiKey!=='string'||!apiKey||/[\r\n]/.test(apiKey))throw Error('Tripo 密钥未配置或格式无效。');
  if(baseUrl.replace(/\/$/,'')!=='https://openapi.tripo3d.com/v3')throw Error('仅允许 Tripo 官方 v3 HTTPS 地址。');
  const root='https://openapi.tripo3d.com/v3';
  async function request(path,body){
    let response;
    try{response=await fetchImpl(root+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${apiKey}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw Error('Tripo 请求未能确认完成；不要重复提交，请先核对任务记录。');}
    if(!response.ok)throw Error(`Tripo HTTP ${response.status}；未自动重试。`);
    let data;try{data=await response.json();}catch{throw Error('Tripo 返回格式无效；请先核对任务记录。');}
    if(data.code!==0)throw Error('Tripo 返回业务错误；未自动重试。');
    // Deliberately do not return arbitrary upstream messages or credentials.
    return data.data;
  }
  function inputValid(input){if(typeof input!=='string'||!/^([a-zA-Z0-9_-]{8,200})$/.test(input))throw Error('请提供 file_token 或任务 ID，不接受任意 URL。');}
  function approved(value){if(value!==true)throw Error('提交前必须明确授权本次付费步骤。');}
  return {
    async generateImage({input,faceLimit,quad=false,approved:approval=false,generateParts=false}={}){
      approved(approval);inputValid(input);if(typeof quad!=='boolean')throw Error('quad 必须为布尔值。');validateFaces(faceLimit,quad);
      if(generateParts)throw Error('P2 生成时分件未验证，禁止发送该参数。');
      const data=await request('/generation/image-to-model',{input,model:'P2-20260801',quad,face_limit:faceLimit,texture:true,pbr:true,orientation:'align_image'});
      if(!data?.task_id)throw Error('未取得任务 ID，停止并核对账单，禁止自动重提。');
      return {taskId:data.task_id};
    },
    async smartUV({input,equivalentTriangles,bake=true,approved:approval=false}={}){
      approved(approval);inputValid(input);
      if(!Number.isInteger(equivalentTriangles)||equivalentTriangles<1||equivalentTriangles>80000)throw Error('先测量实际等价三角面数，必须在 1–80000 内。');
      if(typeof bake!=='boolean')throw Error('bake 必须为布尔值。');
      const data=await request('/mesh/uv',{input,model:'default',bake});
      if(!data?.task_id)throw Error('未取得 UV 任务 ID，停止并核对，禁止自动重提。');
      return {taskId:data.task_id};
    },
    async status(taskId){if(typeof taskId!=='string'||!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(taskId))throw Error('任务 ID 无效。');const data=await request(`/tasks/${taskId}`);return {taskId,status:data?.status,progress:data?.progress};},
  };
}
