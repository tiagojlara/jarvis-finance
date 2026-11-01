import test from 'node:test';
import assert from 'node:assert/strict';
import { periodReturn, portfolioHistory, roiPercent } from '../src/client/history.mjs';

const base = {
  assets: [{ id: 1, currency: 'USD' }],
  transactions: [{ id: 1, asset_id: 1, kind: 'buy', date: '2024-01-02', quantity: 2 }],
  prices: [
    { id: 1, asset_id: 1, date: '2024-01-02', price: 10 },
    { id: 2, asset_id: 1, date: '2024-01-03', price: 12 },
  ],
  dividends: [],
  rates: [
    { date: '2024-01-02', base: 'EUR', quote: 'USD', rate: 1.1 },
    { date: '2024-01-03', base: 'EUR', quote: 'USD', rate: 1.2 },
  ],
  homeCurrency: 'EUR',
};

test('historical portfolio values use the FX rate available on each valuation date', () => {
  assert.deepEqual(portfolioHistory(base), [
    { date: '2024-01-02', value: 20 / 1.1 },
    { date: '2024-01-03', value: 24 / 1.2 },
  ]);
});

test('history omits dates where an open holding has no price snapshot', () => {
  const data = { ...base, prices: [{ id: 1, asset_id: 1, date: '2024-01-03', price: 12 }] };
  assert.deepEqual(portfolioHistory(data), [{ date: '2024-01-03', value: 24 / 1.2 }]);
});

test('cash balance snapshots are valued in portfolio history without trades', () => {
  const data = {
    ...base,
    assets: [], transactions: [], prices: [], dividends: [], homeCurrency: 'USD',
    cash_balances: [
      { id: 1, account_id: 1, asset_id: null, date: '2024-01-02', balance: 100, currency: 'EUR' },
      { id: 2, account_id: 1, asset_id: null, date: '2024-01-03', balance: 125, currency: 'EUR' },
    ],
    rates: [
      { date: '2024-01-02', base: 'EUR', quote: 'USD', rate: 1.1 },
      { date: '2024-01-03', base: 'EUR', quote: 'USD', rate: 1.2 },
    ],
  };
  const history = portfolioHistory(data);
  assert.deepEqual(history.map((point) => point.date), ['2024-01-02', '2024-01-03']);
  assert.ok(Math.abs(history[0].value - 110) < 1e-10);
  assert.equal(history[1].value, 150);
});

test('ROI and period return use transparent start/end value calculations', () => {
  assert.equal(roiPercent(120, 100), 20);
  assert.equal(roiPercent(0, 0), null);
  assert.ok(Math.abs(periodReturn([{ value: 100 }, { value: 115 }]) - 15) < 1e-10);
  assert.equal(periodReturn([{ value: 0 }, { value: 115 }]), null);
});
