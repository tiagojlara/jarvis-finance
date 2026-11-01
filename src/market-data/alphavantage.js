async function request(params, apiKey) {
  const url = new URL('https://www.alphavantage.co/query');
  for (const [key, value] of Object.entries({ ...params, apikey: apiKey })) url.searchParams.set(key, value);
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(20000) }); }
  catch {
    const error = new Error('Could not reach Alpha Vantage. Check your internet connection and try again.');
    error.status = 502;
    error.publicMessage = error.message;
    throw error;
  }
  let payload;
  try { payload = await response.json(); }
  catch {
    const error = new Error('Alpha Vantage returned an unreadable response.');
    error.status = 502;
    error.publicMessage = error.message;
    throw error;
  }
  if (!response.ok || payload?.Note || payload?.Information || payload?.['Error Message']) {
    const providerMessage = `${payload?.Note || ''} ${payload?.Information || ''}`;
    const rateLimited = response.status === 429 || /rate limit|call frequency|requests per day|daily limit|per day/i.test(providerMessage);
    const error = new Error('Alpha Vantage request failed.');
    error.status = rateLimited ? 429 : response.status === 401 ? 401 : 502;
    error.publicMessage = rateLimited
      ? 'Alpha Vantage reports that this API key has reached a usage limit. Its daily allowance is shared across every app using this key; this app’s counter only tracks requests made here. Try again after the provider resets, or use manual prices / switch back to Marketstack.'
      : payload?.['Error Message']
        ? 'Alpha Vantage could not find that symbol. Check the symbol and try again.'
        : /premium|subscription|entitlement/i.test(providerMessage)
          ? 'Alpha Vantage says this data or symbol requires a premium entitlement. Try another supported symbol, use manual prices, or switch back to Marketstack.'
          : 'Alpha Vantage request failed. Check the API key and service status.';
    throw error;
  }
  return payload;
}

async function fetchLatestPrice(symbol, apiKey) {
  const payload = await request({ function: 'GLOBAL_QUOTE', symbol }, apiKey);
  const raw = payload['Global Quote'] || {};
  const close = Number(raw['05. price']);
  const date = raw['07. latest trading day'];
  if (!(close > 0) || !date) return null;
  return { symbol: raw['01. symbol'] || symbol, close, date };
}

function pickLatestOnOrBefore(series, date) {
  if (!series) return null;
  const chosen = Object.keys(series).filter((day) => day <= date).sort().at(-1);
  const close = chosen ? Number(series[chosen]['4. close']) : NaN;
  return chosen && close > 0 ? { date: chosen, close } : null;
}

// The close on or before `date`, matching how the app values holdings on any given day.
// Free-tier reality (verified against the live API): exact daily closes only reach back
// ~100 trading days (outputsize=full is a premium feature), so dates beyond that fall
// back to the free weekly series (~2 years). Each weekly key is that week's last trading
// day, so the fallback is still a real close on or before the date — just Friday's, not
// the exact day's. gate() and pace() let the caller meter and space every provider call.
async function fetchPriceOnDate(symbol, date, apiKey, { gate = () => true, pace = async () => {} } = {}) {
  const quotaError = () => {
    const error = new Error('Alpha Vantage daily request limit reached. Try again tomorrow.');
    error.status = 429;
    error.publicMessage = error.message;
    return error;
  };
  if (!gate()) throw quotaError();
  await pace();
  const daily = await request({ function: 'TIME_SERIES_DAILY', symbol, outputsize: 'compact' }, apiKey);
  const exact = pickLatestOnOrBefore(daily['Time Series (Daily)'], date);
  if (exact) return { symbol, ...exact, exact: true };
  if (!gate()) throw quotaError();
  await pace();
  const weekly = await request({ function: 'TIME_SERIES_WEEKLY', symbol }, apiKey);
  const approx = pickLatestOnOrBefore(weekly['Weekly Time Series'], date);
  return approx ? { symbol, ...approx, exact: false } : null;
}

async function searchSymbols(keywords, apiKey) {
  const payload = await request({ function: 'SYMBOL_SEARCH', keywords }, apiKey);
  return (payload.bestMatches || []).map((match) => ({
    symbol: match['1. symbol'],
    name: match['2. name'],
    type: match['3. type'],
    region: match['4. region'],
    currency: String(match['8. currency'] || '').toUpperCase(),
    matchScore: Number(match['9. matchScore'] || 0),
  })).filter((match) => match.symbol);
}

module.exports = { fetchLatestPrice, fetchPriceOnDate, searchSymbols };
