// The card renderer's reader: what the prompt asks for, what models actually send, and what a
// summary cached before the format existed must still do. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSummary, summaryKind } from '../src/assistant/summaryFormat.mjs';

test('a labelled reply becomes a headline plus marked points', () => {
  const parsed = parseSummary([
    'LEAD: November is steady, but your EUR is one position deep.',
    'PLUS: You saved 75% of the income you recorded this month.',
    'WATCH: 85.7% of your EUR total sits in Big Fund.',
    'NOTE: Two holdings carry no price, so their value is unknown.',
  ].join('\n'));
  assert.equal(parsed.structured, true);
  assert.equal(parsed.lead, 'November is steady, but your EUR is one position deep.');
  assert.deepEqual(parsed.points.map((point) => point.kind), ['plus', 'watch', 'note']);
  assert.equal(parsed.points[1].text, '85.7% of your EUR total sits in Big Fund.');
  assert.equal(summaryKind('watch').label, 'Worth a look');
  assert.equal(parsed.paragraphs.length, 0);
});

test('the labels a model drifts to are read as the ones the card knows', () => {
  const parsed = parseSummary('Headline: quiet month.\nGOOD: income is up 10%.\nRISK: spending is all Housing.\nMISSING: no rates for BRL.');
  assert.equal(parsed.lead, 'quiet month.');
  assert.deepEqual(parsed.points.map((point) => point.kind), ['plus', 'watch', 'note']);
});

test('markdown decoration and stray bullets are stripped, not rendered', () => {
  const parsed = parseSummary('**LEAD:** **steady**.\n- WATCH: `85.7%` in one fund.');
  assert.equal(parsed.lead, 'steady.');
  assert.deepEqual(parsed.points, [{ kind: 'watch', text: '85.7% in one fund.' }]);
});

test('a second LEAD is kept as a point rather than dropped', () => {
  const parsed = parseSummary('LEAD: first.\nLEAD: second.');
  assert.equal(parsed.lead, 'first.');
  assert.deepEqual(parsed.points, [{ kind: 'plain', text: 'second.' }]);
});

test('a sentence that merely starts with a label-shaped word is not a label', () => {
  // No colon after "Next" or "Note", so nothing is eaten: the card must not lose the first word.
  const parsed = parseSummary('Next month the rent is due early.\nNote that two thirds sit in one fund.');
  assert.equal(parsed.structured, false);
  assert.deepEqual(parsed.paragraphs, ['Next month the rent is due early.', 'Note that two thirds sit in one fund.']);
});

test('unstructured text still renders, so a cached card is never an error', () => {
  const parsed = parseSummary('As of 2026-11-09 the totals are 495,992.62 SEK and 130,000 BRL, with no currencies converted.');
  assert.equal(parsed.lead, '');
  assert.equal(parsed.points.length, 0);
  assert.equal(parsed.paragraphs.length, 1);
});

test('a partly labelled reply keeps its other sentences as plain points', () => {
  const parsed = parseSummary('LEAD: steady.\nYour largest position is also your best performer.');
  assert.equal(parsed.lead, 'steady.');
  assert.deepEqual(parsed.points, [{ kind: 'plain', text: 'Your largest position is also your best performer.' }]);
});

test('empty and whitespace replies parse without throwing', () => {
  for (const value of ['', '   ', undefined, null, '\n\n']) {
    const parsed = parseSummary(value);
    assert.equal(parsed.lead, '');
    assert.equal(parsed.points.length, 0);
    assert.equal(parsed.paragraphs.length, 0);
  }
});
