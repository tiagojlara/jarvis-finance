const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchPriceOnDate } = require('../src/market-data/alphavantage');

// The free tier rejects outputsize=full outright (verified live); these tests pin the
// fallback chain to requests the free key can actually serve.
function withFetch(handler) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const payload = handler(String(url));
    return { ok: true, status: 200, async json() { return payload; } };
  };
  return { urls, run: async (fn) => { try { return await fn(); } finally { globalThis.fetch = real; } } };
}

test('dated fetch stays in the free tier and falls back to weekly closes', async () => {
  const env = withFetch((url) => url.includes('TIME_SERIES_WEEKLY')
    ? { 'Weekly Time Series': { '2024-03-15': { '4. close': '9.75' }, '2023-01-06': { '4. close': '8.00' } } }
    : { 'Time Series (Daily)': { '2026-06-10': { '4. close': '12.00' } } }); // recent window only

  const result = await env.run(async () => {
    let gated = 0;
    const quote = await fetchPriceOnDate('AAPL', '2024-03-15', 'key', { gate: () => { gated += 1; return true; } });
    return { quote, gated };
  });

  assert.ok(env.urls[0].includes('outputsize=compact'), 'must never ask for the premium outputsize=full');
  assert.ok(env.urls[1].includes('TIME_SERIES_WEEKLY'), 'older dates fall back to the free weekly series');
  assert.equal(result.quote.close, 9.75);
  assert.equal(result.quote.date, '2024-03-15');
  assert.equal(result.quote.exact, false, 'weekly closes are flagged as approximate');
  assert.equal(result.gated, 2, 'each provider call consumes one quota slot');
});

test('recent dates resolve exactly from the daily window with one request', async () => {
  const env = withFetch(() => ({ 'Time Series (Daily)': { '2026-06-11': { '4. close': '12.50' }, '2026-06-10': { '4. close': '12.00' } } }));
  const result = await env.run(async () => {
    let gated = 0;
    const quote = await fetchPriceOnDate('AAPL', '2026-06-10', 'key', { gate: () => { gated += 1; return true; } });
    return { quote, gated };
  });
  assert.equal(env.urls.length, 1);
  assert.deepEqual(
    { close: result.quote.close, date: result.quote.date, exact: result.quote.exact },
    { close: 12, date: '2026-06-10', exact: true },
  );
  assert.equal(result.gated, 1);
});

test('a spent allowance stops the fetch before any provider call', async () => {
  const env = withFetch(() => ({}));
  await assert.rejects(
    () => env.run(() => fetchPriceOnDate('AAPL', '2026-06-10', 'key', { gate: () => false })),
    /daily request limit/i,
  );
  assert.equal(env.urls.length, 0);
});
