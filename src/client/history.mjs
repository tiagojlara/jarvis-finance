function rateOn(rates, from, to, date) {
  if (from === to) return 1;
  const eligible = rates.filter((rate) => rate.date <= date);
  const direct = eligible.filter((rate) => rate.base === from && rate.quote === to).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (direct) return Number(direct.rate);
  const inverse = eligible.filter((rate) => rate.base === to && rate.quote === from).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (inverse) return 1 / Number(inverse.rate);
  if (from !== 'EUR' && to !== 'EUR') {
    const fromPerEur = eligible.filter((rate) => rate.base === 'EUR' && rate.quote === from).sort((a, b) => b.date.localeCompare(a.date))[0];
    const toPerEur = eligible.filter((rate) => rate.base === 'EUR' && rate.quote === to).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (fromPerEur && toPerEur) return Number(toPerEur.rate) / Number(fromPerEur.rate);
  }
  if (to === 'EUR') {
    const eurPerFrom = eligible.filter((rate) => rate.base === 'EUR' && rate.quote === from).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (eurPerFrom) return 1 / Number(eurPerFrom.rate);
  }
  if (from === 'EUR') {
    const toPerEur = eligible.filter((rate) => rate.base === 'EUR' && rate.quote === to).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (toPerEur) return Number(toPerEur.rate);
  }
  return null;
}

export function portfolioHistory({ assets, transactions, prices, dividends, rates, homeCurrency }) {
  const dates = new Set([...transactions, ...prices, ...dividends].map((row) => row.date).filter(Boolean));
  const orderedTransactions = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const orderedPrices = [...prices].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const result = [];
  for (const date of [...dates].sort()) {
    let value = 0;
    let complete = true;
    for (const asset of assets) {
      let quantity = 0;
      for (const transaction of orderedTransactions) {
        if (transaction.asset_id !== asset.id || transaction.date > date) continue;
        if (transaction.kind === 'buy') quantity += Number(transaction.quantity || 0);
        if (transaction.kind === 'sell') quantity -= Number(transaction.quantity || 0);
      }
      if (quantity <= 0) continue;
      const price = [...orderedPrices].reverse().find((row) => row.asset_id === asset.id && row.date <= date);
      if (!price) { complete = false; break; }
      const fx = rateOn(rates, asset.currency, homeCurrency, date);
      if (fx == null) { complete = false; break; }
      value += quantity * Number(price.price) * fx;
    }
    if (complete) result.push({ date, value });
  }
  return result;
}
