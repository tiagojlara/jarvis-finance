import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceHistory } from '../src/client/price-import.mjs';

test('parses Swedish value-curve exports: semicolons, decimal commas, dd/mm/yyyy, header', () => {
  const { rows, skipped } = parsePriceHistory('Datum;Värde\n02/01/2026;1 234,56\n03/01/2026;1240,10\n04/01/2026;bork\n05.01.2026;125,00\n');
  assert.deepEqual(rows, [
    { date: '2026-01-02', price: 1234.56 },
    { date: '2026-01-03', price: 1240.1 },
    { date: '2026-01-05', price: 125 },
  ]);
  assert.equal(skipped, 1, 'the unreadable row is counted, not guessed');
});

test('accepts ISO dates and thousands dots, dedupes by date with last row winning, sorts', () => {
  const { rows } = parsePriceHistory('2026-02-02;1.210,00\n2026-02-01;1200\n2026-02-02;1211,5\n');
  assert.deepEqual(rows, [
    { date: '2026-02-01', price: 1200 },
    { date: '2026-02-02', price: 1211.5 },
  ]);
});

test('handles comma-delimited files with dot decimals (English exports)', () => {
  const { rows } = parsePriceHistory('Date,Value\n01/02/2026,1234.56\n');
  assert.deepEqual(rows, [{ date: '2026-02-01', price: 1234.56 }]);
});

test('reports unusable input instead of importing noise', () => {
  assert.match(parsePriceHistory('').error, /empty/i);
  assert.match(parsePriceHistory('just one column\nanother line').error, /delimiter/i);
  assert.match(parsePriceHistory('Datum;Värde\ngarbage;stuff').error, /date \+ value/i);
});
