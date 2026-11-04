// AI Agent Guide for 映纹工坊 (Yingwen Workbench)
// This file is served at GET /api/automation/guide and is meant to be read by AI agents.
// It explains what the workbench does, the recommended workflow, and every available method.

export const GUIDE = `
# 映纹工坊 · AI 自动化指南

你正在和一个本地运行的 3D 贴图工作台交互。它的作用是：给一个带 UV 的 3D 模型，根据一张参考图，用 AI 生成颜色、法线、粗糙度、金属度、自发光等贴图，然后导出给游戏引擎（UE5 / Unity）使用。

## 前提条件

1. 工作台页面必须在浏览器中打开（默认 http://127.0.0.1:5173/）。
2. 页面上必须已经导入了一个模型（GLB / OBJ / FBX，需要有 UV）。
3. API 密钥必须已配置（第一次使用时在页面里填过，之后会自动连接）。

## 调用方式

在浏览器页面里执行 JavaScript（通过 Playwright、Puppeteer、Chrome DevTools Protocol 或浏览器控制台）：

\`\`\`js
const api = window.__workbenchAuto;
const result = await api.方法名(参数);
\`\`\`

也可以用 postMessage（适合 iframe / Electron）：
\`\`\`js
window.postMessage({ workbench: { id: '唯一ID', method: '方法名', params: { ... } } }, '*');
// 监听 window message 事件，匹配 e.data.workbenchResult.id
\`\`\`

## 推荐工作流（按顺序执行）

### 第一步：检查状态
\`\`\`js
const s = await api.status();
// s = { model: true/false, channel: 'color', layers: 0, busy: false }
// 如果 model 是 false，需要先在页面上导入模型。
\`\`\`

### 第二步：六面颜色
\`\`\`js
await api['generate-six']({ channel: 'color', size: 4096 });
// 自动截取前、后、左、右、上、下 6 个方向，用 AI 生成颜色贴图，合并投射到 UV。
// 每张约 1 分钟，总共约 2 分钟。size 是 UV 烘焙尺寸，可选 4096 或 8192。
// 需要页面上已经上传了参考图。
\`\`\`

### 第三步：六面法线
\`\`\`js
await api['generate-six']({ channel: 'normal', size: 4096 });
// 同样 6 面，生成法线贴图。AI 法线会自动只取细节，叠加到模型原有法线上。
\`\`\`

### 第四步：按模型形状加明暗
\`\`\`js
await api.shade({ size: 4096 });
// 按模型的凹凸给颜色贴图加明暗：凹处压暗、凸棱提亮。
// 2-3 秒，不需要 AI，纯计算。
\`\`\`

### 第五步：烘焙 AO
\`\`\`js
await api.ao({ size: 4096, samples: 96 });
// 环境光遮蔽，写入 ORM 的 R 通道。1-2 秒。
\`\`\`

### 第六步：分材质
\`\`\`js
await api.zones({ count: 6 });
// 按颜色自动分成几种材质（如银、铜、金），每种有默认的金属度和粗糙度。
// 之后可以在页面上手动调整每种材质的数值。
\`\`\`

### 第七步（可选）：UV 细化
\`\`\`js
await api['uv-refine']({ channel: 'color', size: 4096 });
// 把 UV 贴图交给 AI 补细节，只叠加细小纹理，大块颜色不变。
// 约 1 分钟。建议在六面颜色之后、导出之前执行。
\`\`\`

### 第八步（可选）：六面自发光
\`\`\`js
await api['generate-six']({ channel: 'emissive', size: 4096 });
// 只保留发光的部分（眼睛、宝石、符文等），其他地方是黑色。
\`\`\`

### 导出

导出目前需要通过页面上的按钮点击（"导出贴图"），或通过 Playwright 模拟点击：
\`\`\`js
// 在 Playwright 中
await page.click('#exportBtn');
await page.click('#exportColor');  // BaseColor PNG
await page.click('#exportNormal'); // Normal PNG (OpenGL)
await page.click('#exportORM');    // ORM PNG (R=AO, G=Roughness, B=Metallic)
await page.click('#exportEmissive'); // Emissive PNG
await page.click('#exportRough');  // 单独的 Roughness + Metallic PNG
await page.click('#exportUnity');  // Unity URP 格式
await page.click('#exportModel');  // GLB（包含所有贴图）
\`\`\`

## 其他操作

### 粗糙度 / 金属度画笔
画笔操作需要通过页面 UI 或 Playwright 模拟鼠标。在页面中：
\`\`\`js
// 切换到粗糙度视图
document.querySelector('[data-channel="roughness"]').click();
// 或金属度
document.querySelector('[data-channel="metalness"]').click();
// 画笔通过鼠标在视口中拖动
\`\`\`

### 投射涂选（画笔控制投射区域）
当有一张待投射图片时：
\`\`\`js
document.querySelector('#brushToggle').checked = true;
document.querySelector('#brushToggle').dispatchEvent(new Event('change'));
// 然后在视口中用鼠标涂选要投射的区域
\`\`\`

### 切面（补被挡住的地方）
\`\`\`js
window.__workbench.scene.setCut({ axis: 'x', keep: 1, offset: 0 }); // 切掉左半
window.__workbench.scene.setCut(null); // 恢复
\`\`\`

### 部件显隐
\`\`\`js
const parts = window.__workbench.scene.getParts();
window.__workbench.scene.setPartVisible(parts[0].id, false); // 隐藏第一个部件
window.__workbench.scene.showAllParts(); // 全部显示
\`\`\`

## 注意事项

- 所有 generate 方法都会消耗 API 额度（Seedream 5 约 0.03 美元 / 张）。
- 六面生成 = 6 张图 × 0.03 = 约 0.18 美元。
- shade、ao、zones 不调用 AI，不花钱。
- 模型需要有 UV。没有 UV 的模型会报错。
- 同一时间只能执行一个操作（busy = true 时调用会报错）。
- 生成过程中页面不能刷新，否则进度会丢失。
- 页面上的参考图需要手动上传（通过 Playwright 的 setInputFiles）。

## HTTP 接口（不需要浏览器）

这些接口可以直接用 curl 或 fetch 调用，不需要打开浏览器页面：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 服务是否在运行 |
| GET | /api/config | 接口配置（不含密钥） |
| POST | /api/config | 保存 API 密钥 { baseUrl, apiKey } |
| GET | /api/models | 可用的图片模型列表 |
| POST | /api/generate | 调用图片模型生成 |
| GET | /api/automation | 方法列表 |
| GET | /api/automation/guide | 本文档 |
`;
