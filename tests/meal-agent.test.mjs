import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarContext } from '../core/context.mjs';
import { defaultPreferences, learnFeedback, rankCandidates, factReason } from '../core/pick.mjs';

test('calendar uses China dates and verified 2026 makeup days; unknown years have no invented holidays', () => {
  const makeup = calendarContext(new Date('2026-10-10T09:00:00Z'));
  assert.equal(makeup.dayKind, 'workday'); assert.equal(makeup.makeupWorkday, true); assert.equal(makeup.holiday, null);
  const holiday = calendarContext(new Date('2026-09-30T16:00:00Z'));
  assert.equal(holiday.date, '2026-10-01'); assert.equal(holiday.holiday, '国庆节');
  assert.equal(calendarContext(new Date('2026-09-22T00:00:00Z')).upcoming.name, '中秋节');
  const unknown = calendarContext(new Date('2027-02-16T09:00:00Z'));
  assert.equal(unknown.holidayVerified, false); assert.equal(unknown.holiday, null); assert.equal(unknown.upcoming, null);
});

test('feedback memory changes rank and reasons stay factual', () => {
  const beef = { id: 'b', title: '巨无霸', priceFen: 2000, savingFen: 0, parts: [{ name: '巨无霸', code: '1' }] };
  const chicken = { id: 'c', title: '麦香鸡', priceFen: 1800, savingFen: 100, parts: [{ name: '麦香鸡', code: '2' }] };
  const prefs = learnFeedback(defaultPreferences(), beef, 'like', ['1'], '2026-10-13');
  assert.equal(prefs.feedback.at(-1).vote, 'like');
  const ranked = rankCandidates([chicken, beef], { taste: { meats: ['牛肉'], likes: [{ name: '巨无霸' }], less: [] }, budgetFen: 3000 });
  assert.equal(ranked.ranked[0].id, 'b');
  assert.match(factReason(beef, { rank: 1, taste: { meats: ['牛肉'] }, cheaper: 0 }), /牛肉|最便宜/);
  assert.doesNotMatch(factReason(beef, { rank: 1 }), /秋天|下午茶/);
});
