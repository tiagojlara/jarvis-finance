import test from 'node:test';
import assert from 'node:assert/strict';
import { cashFlowTotals, categoryBreakdown, shiftMonth } from '../src/client/cashflow.mjs';

const entries = [
  { kind: 'income', amount: 2400, currency: 'EUR', date: '2026-11-01', category_id: 1 },
  { kind: 'income', amount: 150, currency: 'EUR', date: '2026-11-15', category_id: 2 },
  { kind: 'expense', amount: 900, currency: 'EUR', date: '2026-11-02', category_id: 3 },
  { kind: 'expense', amount: 80.5, currency: 'EUR', date: '2026-11-03', category_id: 4 },
  { kind: 'expense', amount: 19.5, currency: 'EUR', date: '2026-11-20', category_id: 4 },
  { kind: 'expense', amount: 300, currency: 'SEK', date: '2026-11-04', category_id: 4 },
  { kind: 'income', amount: 5000, currency: 'SEK', date: '2026-10-28', category_id: 1 },
];
const categories = [
  { id: 1, name: 'Salary', kind: 'income' },
  { id: 2, name: 'Other income', kind: 'income' },
  { id: 3, name: 'Housing', kind: 'expense' },
  { id: 4, name: 'Food', kind: 'expense' },
];

test('month totals stay per currency and net income minus expense', () => {
  const november = entries.filter((entry) => entry.date.startsWith('2026-11'));
  const totals = cashFlowTotals(november);
  assert.deepEqual(totals.EUR, { income: 2550, expense: 1000, net: 1550 });
  assert.deepEqual(totals.SEK, { income: 0, expense: 300, net: -300 });
  assert.deepEqual(Object.keys(totals).sort(), ['EUR', 'SEK'], 'totals exist per currency only, never combined or converted');
});

test('category breakdown sorts expenses per currency, largest first', () => {
  const november = entries.filter((entry) => entry.date.startsWith('2026-11'));
  assert.deepEqual(categoryBreakdown(november, categories, 'expense'), [
    { currency: 'EUR', category_id: 3, name: 'Housing', total: 900, count: 1 },
    { currency: 'SEK', category_id: 4, name: 'Food', total: 300, count: 1 },
    { currency: 'EUR', category_id: 4, name: 'Food', total: 100, count: 2 },
  ]);
  assert.deepEqual(categoryBreakdown(november, categories, 'income'), [
    { currency: 'EUR', category_id: 1, name: 'Salary', total: 2400, count: 1 },
    { currency: 'EUR', category_id: 2, name: 'Other income', total: 150, count: 1 },
  ]);
});

test('shiftMonth crosses year ends correctly', () => {
  assert.equal(shiftMonth('2026-11', -1), '2026-10');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-11', 0), '2026-11');
});
