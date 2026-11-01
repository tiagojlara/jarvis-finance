import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioHistory } from '../src/client/history.mjs';

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
