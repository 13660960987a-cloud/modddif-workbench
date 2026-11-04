// 本地验收规则，不调用模型、不产生视觉评分。评分来源与证据必须显式提供。
export const RUBRIC = [
  { key: 'structure', label: '参考还原与结构对位', weight: 30 },
  { key: 'detail', label: '重点区域与特写细节', weight: 25 },
  { key: 'material', label: '材质表现', weight: 20 },
  { key: 'projection', label: '投射、接缝与多视角一致', weight: 15 },
  { key: 'style', label: '整体风格与完成度', weight: 10 },
];
export const REQUIRED_EVIDENCE = [
  ['reference', '参考图'], ['overall', '整体效果'], ['front', '经确认的真正正脸 / 主视角'],
  ['closeup', '脸部 / 关键区域特写'], ['left', '左侧'], ['right', '右侧'],
  ['albedo', '纯颜色检查'], ['material', '统一灯光下的材质检查'],
];
export const HARD_CHECKS = [
  ['alignment', '结构对位正确，无明显错位'], ['seams', '无明显接缝、重影或拉伸'],
  ['lighting', '固有色没有不应存在的光影'], ['density', '关键区域实际像素和 UV 密度足够'],
  ['regression', '局部返修未破坏侧面和整体'],
];
const text = value => typeof value === 'string' && value.trim().length > 0;
const scoreValid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10;

export function evaluateReview({ revision, evidence = [], review = {} } = {}) {
  const reasons = [];
  const images = new Map(evidence.filter(e => text(e.id) && e.revision === revision && text(e.image)).map(e => [e.id, e]));
  const refsValid = ids => Array.isArray(ids) && ids.length > 0 && ids.every(id => images.has(id));
  if (!text(revision)) reasons.push('缺少成果版本标识');
  if (review.revision !== revision) reasons.push('评分不属于当前成果版本');
  if (!text(review.reviewer) || !['human', 'vision-model'].includes(review.reviewerType)) reasons.push('未标明人工或视觉模型评审来源');
  for (const [kind, label] of REQUIRED_EVIDENCE) {
    if (![...images.values()].some(e => e.kind === kind && e.confirmed === true)) reasons.push(`缺少已确认的${label}证据`);
  }
  const rubric = RUBRIC.map(item => {
    const entry = review.scores?.[item.key];
    const valid = scoreValid(entry?.score) && text(entry?.reason) && refsValid(entry?.evidenceIds);
    if (!valid) reasons.push(`${item.label}尚未完成带证据的评分`);
    return { ...item, score: valid ? entry.score : null, reason: entry?.reason || '' };
  });
  const complete = rubric.every(r => r.score !== null);
  const rawScore = complete ? rubric.reduce((s, r) => s + r.score * r.weight / 100, 0) : null;
  for (const [key, label] of HARD_CHECKS) {
    const check = review.checks?.[key];
    if (check?.pass !== true || !text(check.reason) || !refsValid(check.evidenceIds)) reasons.push(`${label}：未通过或未检查`);
  }
  if (!Array.isArray(review.issues)) reasons.push('未提供问题清单（无问题时也需提供空数组）');
  else if (review.issues.some(i => !i || !['minor', 'major', 'critical'].includes(i.severity) || !text(i.description) || !refsValid(i.evidenceIds))) reasons.push('问题清单格式或证据不完整');
  else if (review.issues.some(i => ['major', 'critical'].includes(i.severity))) reasons.push('仍有明显或严重缺陷');
  if (rawScore !== null && rawScore < 9) reasons.push('加权总分未达到 9 分');
  if (rubric.some(r => r.score !== null && r.score < 8.5)) reasons.push('存在低于 8.5 分的分项');
  if (rubric.find(r => r.key === 'detail').score !== null && rubric.find(r => r.key === 'detail').score < 9) reasons.push('重点区域与特写未达到 9 分');
  return { revision, score: rawScore === null ? null : Math.round(rawScore * 100) / 100, passed: reasons.length === 0, status: reasons.length ? '未通过 / 待验收' : '辅助验收通过（仍需人工确认）', reasons, rubric, disclaimer: '此模块只校验评分规则，不识别图像。已确认视角和视觉结论由评审者负责，不代表系统已识别正脸。' };
}

export function reviewTemplate(revision) {
  return { revision, reviewer: '', reviewerType: 'vision-model', scores: Object.fromEntries(RUBRIC.map(r => [r.key, { score: null, reason: '', evidenceIds: [] }])), checks: Object.fromEntries(HARD_CHECKS.map(([key]) => [key, { pass: null, reason: '', evidenceIds: [] }])), issues: [] };
}
