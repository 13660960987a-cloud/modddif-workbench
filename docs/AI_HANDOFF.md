# 映纹工坊 · AI 接手协议

## 第一条：接手顺序

新 AI 不依赖聊天历史，必须按顺序执行：

1. `GET /api/automation/guide` 读取本文档。
2. 页面同源环境调用 `window.__workbenchAuto.capabilities()`。
3. 调用 `status()`，确认模型、UV、忙闲状态和 `task`。
4. 先用 `capture-evidence()` 或界面操作取证；真正正脸、特写和左右侧面必须由 AI 实际打开图片确认，不能把坐标轴 front 自动当脸。
5. 只有在评审后，才执行付费方法；每次等待返回，不并发调用。
6. 生成后重新取证、评分、导出；没有证据就返回“未验收”，不能说完成。

## 真实能力发现

`capabilities()` 返回本版本真实入口、付费方法、本地方法、不支持功能和必须人工检查的项目。以返回值为准，不猜不存在的 HTTP 端点。

当前接口是浏览器同源接口：

```js
const api = window.__workbenchAuto;
const cap = await api.capabilities();
const s = await api.status();
```

`window.__workbench` 只供开发调试，不能作为交付接口。没有 HTTP 自动化任务队列；云端 AI 不能直接访问用户电脑的 127.0.0.1，必须通过本机浏览器工具、插件或用户提供的本地桥接。

## 任务互斥与费用

任务 ID 只在当前页面内有效，未持久化，不能用于断点恢复。生成、UV 细化、AO、分区、导出等会互斥。`status().task` 非空时不得再调用。接口会返回任务进行中的错误；不要自动重试付费请求。网络超时先查供应商状态或由用户确认，不重复提交。

本地计算：`status`、`capture-evidence`、`review-template`、`review-evaluate`、`shade`、`ao`、`zones`。可能收费：`generate-six`、`uv-refine`。仓库里有未接入网站的 Tripo P2 规划模块；界面有批量文件替换能力，但当前没有暴露为自动化 HTTP 方法，不要假装可用。

## 生成质量流程

- 先保存版本标识和当前成果。
- 先修结构对位，再补特写细节；不要用升 8K、锐化或整模重抽代替错误的脸部结构。
- 颜色必须经过抠图和去光照；法线尽量使用界面已连接的 detail-normal 流程；自发光需检查黑底过滤。
- 六面生成结果必须检查全景、真正正脸、眼鼻嘴特写、左右侧面、纯颜色和统一灯光材质。
- 9 分是验收目标，不是给评审的指令。评分规则：结构 30%、特写 25%、材质 20%、投射 15%、整体 10%；总分≥9、特写≥9、其余分项≥8.5，且无明显/严重缺陷才可辅助通过。

## 当前方法示例

```js
const cap = await api.capabilities();
if (cap.localOnly !== true) throw new Error('不是本地工作台');
const status = await api.status();
if (status.task || status.busy) throw new Error('等待当前任务');
const evidence = await api['capture-evidence'](); // 需要实际打开图片确认
const template = await api['review-template']({revision: 'asset-001'});
// 填完带证据的 review 后：
const result = await api['review-evaluate']({revision, evidence, review});
```

`capture-evidence()` 返回当前视口截图，`confirmed` 默认 false。它不会判断是不是正脸。AI 必须把截图实际传给自己的视觉能力检查，再建立 evidence 记录。

## 批量和原项目替换

批量任务先生成清单，不默认覆盖原项目。新贴图先放独立输出目录，完成验收后逐对指定原图相对路径。写回前备份，写入前后核对 SHA-256；原图在过程中被修改则停止。保留 Unity `.meta`，但共享贴图可能影响多个对象，必须报告。GLB 内嵌贴图不能按外部 PNG 直接替换。

## Tripo P2

Tripo 的 P2 文件规范在 `docs/TRIPO_AI_POLICY.md`，必须先读。P2 API 密钥只由本地后端读取，不能打印或放进前端。三角面上限 50000，四边面上限 25000；Smart UV 要求实际等价三角面不超过 80000。分件参数未完成当前 P2 schema 验证时，走后处理，不盲传 `generate_parts`。
