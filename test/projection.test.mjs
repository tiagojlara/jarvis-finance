import test from 'node:test';
import assert from 'node:assert/strict';
import { project, projectedValue } from '../src/projection.mjs';

test('monthly contributions compound and withdrawals reduce projection', () => {
  const p = project({ startingValue: 1000, monthlyContribution: 100, annualReturn: 0, inflation: 0, years: 2 });
  assert.equal(p.at(-1).value, 3400);
  const q = project({ startingValue: 1000, monthlyContribution: 0, annualReturn: 0, inflation: 0, years: 1, monthlyWithdrawal: 10 });
  assert.equal(q.at(-1).value, 880);
});

test('annual return compounds monthly', () => {
  const value = projectedValue({ startingValue: 1000, annualReturn: 0.1, years: 1 });
  assert.ok(Math.abs(value - 1100) < 1e-9);
});

test('projection reports a point at the start of each year plus the final value', () => {
  const points = project({ startingValue: 1000, monthlyContribution: 0, annualReturn: 0, years: 3 });
  assert.deepEqual(points.map((point) => point.year), [0, 1, 2, 3]);
  assert.equal(points.at(-1).value, 1000);
});
