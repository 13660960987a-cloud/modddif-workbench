import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReview, reviewTemplate, REQUIRED_EVIDENCE } from '../src/quality-review.js';
function fixture() {
  const revision = 'test-001';
  const evidence = REQUIRED_EVIDENCE.map(([kind]) => ({ id: kind, kind, revision, image: 'test-fixture.png', confirmed: true }));
  const review = reviewTemplate(revision);
  review.reviewer = '单元测试模拟评审';
  for (const entry of Object.values(review.scores)) Object.assign(entry, { score: 9, reason: '测试理由', evidenceIds: ['front'] });
  for (const entry of Object.values(review.checks)) Object.assign(entry, { pass: true, reason: '测试检查', evidenceIds: ['front'] });
  return { revision, evidence, review };
}
test('空评审不能自动给分', () => { const r = evaluateReview(); assert.equal(r.score, null); assert.equal(r.passed, false); });
test('完整证据和评分可通过规则（不代表视觉验证）', () => { const r = evaluateReview(fixture()); assert.equal(r.score, 9); assert.equal(r.passed, true); });
test('缺少特写即使满分也不通过', () => { const x = fixture(); x.evidence = x.evidence.filter(e => e.kind !== 'closeup'); for (const s of Object.values(x.review.scores)) s.score = 10; assert.equal(evaluateReview(x).passed, false); });
test('特写低于9不能被高分平均掩盖', () => { const x = fixture(); for (const s of Object.values(x.review.scores)) s.score = 10; x.review.scores.detail.score = 8.9; assert.equal(evaluateReview(x).passed, false); });
test('旧版本评分不能沿用', () => { const x = fixture(); x.revision = 'test-002'; assert.equal(evaluateReview(x).passed, false); });
test('无效和缺失评分不隐式转换为零', () => { for (const value of [null, '', '9', NaN, Infinity, 11]) { const x = fixture(); x.review.scores.detail.score = value; assert.equal(evaluateReview(x).score, null); } });
test('明显缺陷阻止通过', () => { const x = fixture(); x.review.issues = [{severity:'major',description:'眼睛错位',evidenceIds:['front']}]; assert.equal(evaluateReview(x).passed, false); });
test('未确认视角及无效证据引用不通过', () => { const x = fixture(); x.evidence[2].confirmed = false; x.review.scores.structure.evidenceIds = ['不存在']; assert.equal(evaluateReview(x).passed, false); });
test('9分以下不能四舍五入通过', () => { const x = fixture(); x.review.scores.style.score = 8.99; assert.equal(evaluateReview(x).passed, false); });
