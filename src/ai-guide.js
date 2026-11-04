// Served locally to agents before they operate the workbench.
export const GUIDE = `
# 映纹工坊 · AI 使用与美术验收指南

## 先读限制

本页不是视觉评分模型。review-evaluate 仅校验外部评审提交的证据与分数，不会看图或自动给 9 分。当前尚未实现自动特写定位、自动返修预算控制或项目完整存档；工具区已有人工验收面板。先调用 capabilities() 发现真实方法，再调用 status() 查看当前任务。task ID 仅在页面本轮存活，不是持久化任务记录。
页面需要打开，模型需要 UV。只使用 window.__workbenchAuto；没有 /api/automation/* 的 HTTP 控制队列。不要使用仅开发版存在的 window.__workbench。
密钥只由本机后端读取，不打印、不提交。不要刷新正在工作的页面。

## 推荐流程

1. 调用 capabilities() 发现真实方法，再调用 status() 检查模型和忙闲状态；一次只运行一个操作。
2. 保存可恢复成果后，再用界面的六面生成。浏览器 generate-six 串行生成，已复用界面图像处理函数及其当前开关设置；仍需实际验收，尚未完成独立 AI 接手测试。
3. 独立评审查看参考、实际模型整体、真正正脸/主视角、关键区域特写、左右侧面、纯颜色、统一灯光材质视图。坐标轴 front 不一定是脸，必须实际确认双眼鼻口完整。
4. 结构错位先修对位，清晰度不足再局部补图；用蒙版限制区域。不要整张反复重抽，也不要用锐化或升到 8K 代替真实细节。
5. 返修前保留旧成果；返修后更换 revision 并重新取证、评分。当前版本标识由调用者管理，系统不能自动检测贴图改变。
6. 检查导出在 Blender / Unity 中的方向、法线、材质和特写；未经验证不得声称通过。

## 评分与硬门槛

结构对位 30%，特写细节 25%，材质 20%，投射接缝 15%，整体 10%。总分至少 9，特写至少 9，其余分项至少 8.5。缺少证据、明显/严重问题、硬性检查未通过时，即使填 10 分也不能通过。
评审者必须记录真实身份/模型来源，不冒充真人专家。分数是主观辅助，不保证成品质量。不要向评审要求“必须打 9 分”。

## 浏览器评审 API（不产生费用）

const api = window.__workbenchAuto;
const review = await api['review-template']({ revision: 'pillar-001' });

review 填写：
- revision：当前成果唯一版本。
- reviewer：评审者名称；reviewerType：human 或 vision-model。
- scores：structure、detail、material、projection、style；每项 { score: 0到10的数字, reason: '具体理由', evidenceIds: ['图片ID'] }。
- checks：alignment、seams、lighting、density、regression；每项 { pass: true或false, reason: '检查结论', evidenceIds: ['图片ID'] }。
- issues：问题数组；无问题也需 []。每条 { severity: 'minor/major/critical', description: '位置、缺陷、返修建议', evidenceIds: ['图片ID'] }。

evidence 为图片记录数组，每条 { id, revision, kind, image, confirmed }。
kind 必须覆盖 reference、overall、front、closeup、left、right、albedo、material。
image 为实际截图 data URL 或可读取路径，confirmed 只有在评审者实际看图确认视角后才为 true。
系统只检查非空图片字段与证据引用，不验证图片内容或可读性；调用者必须真正打开图像。不能把同一张图换名充当多个视角。

const result = await api['review-evaluate']({ revision: 'pillar-001', evidence, review });

result.score 为加权分，未评分完整时为 null；passed 是辅助验收结果；reasons 给出未通过原因。还需要人工最终确认。

## 其他方法与注意

status：读取状态。shade：可选艺术化明暗，会修改固有色，不是严格无光照 albedo。ao：本地 AO。zones：颜色聚类猜材质，必须人工调整，不能视为语义识别。
uv-refine：实验性，可能错位；目前建议仅颜色使用，失败重试可能重复产生费用。法线不要走这条颜色提示词路径。
export：触发浏览器下载，不返回 base64；一次调用会导出全部 UV 材质，请监听浏览器下载事件。
本机计算不付费，generate 和 uv-refine 会请求上游。费用以供应商为准，不承诺固定耗时。返修前由操作者明确次数/预算上限，失败先确认请求状态，不无限重试。
postMessage 仅允许本窗口同源消息；推荐直接调用 api。不支持任意跨域 iframe 控制。

## HTTP 发现

GET /api/health：健康状态。
GET /api/config：无密钥的配置状态。
GET /api/models：图片模型。
GET /api/automation：接口发现。
GET /api/automation/guide：本文，使用前先读。
POST /api/config、DELETE /api/config、POST /api/generate 受来源限制；本地密钥调用必须来自工作台允许的 Origin。
`;
