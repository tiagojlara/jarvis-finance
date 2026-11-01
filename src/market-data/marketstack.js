async function fetchLatestPrices(symbols, apiKey) {
  const url = new URL('https://api.marketstack.com/v2/eod/latest');
  url.searchParams.set('access_key', apiKey);
  url.searchParams.set('symbols', symbols.join(','));

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  } catch {
    const error = new Error('Could not reach Marketstack. Check your internet connection and try again.');
    error.status = 502;
    error.publicMessage = error.message;
    throw error;
  }

  let payload;
  try { payload = await response.json(); }
  catch {
    const error = new Error('Marketstack returned an unreadable response.');
    error.status = 502;
    error.publicMessage = error.message;
    throw error;
  }

  if (!response.ok || payload?.error) {
    const status = Number(payload?.error?.code) === 104 || response.status === 401 ? 401 : response.status === 429 ? 429 : 502;
    const error = new Error('Marketstack request failed.');
    error.status = status;
    error.publicMessage = status === 401
      ? 'Marketstack rejected the API key. Check the key in .env and restart the app.'
      : status === 429
        ? 'Marketstack request limit reached. Check the free-plan monthly quota and try again later.'
        : response.status === 403
          ? 'Marketstack denied this request. Check that the account has access to end-of-day data.'
          : 'Marketstack could not return prices. Check the ticker symbols and try again.';
    throw error;
  }

  if (!Array.isArray(payload?.data)) {
    const error = new Error('Marketstack returned an unexpected price response.');
    error.status = 502;
    error.publicMessage = error.message;
    throw error;
  }
  return payload.data;
}

module.exports = { fetchLatestPrices };
