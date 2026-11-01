const path = require('path');
const express = require('express');
const { openDatabase } = require('./db');
const { createPortfolioRouter } = require('./routes/portfolio');
const { createPricesRouter } = require('./routes/prices');

// App factory: pass a dataDir (and, in tests, fetch overrides). No listening here — server.js owns that.
function createApp(options = {}) {
  const db = options.db || openDatabase(options.dataDir || path.join(__dirname, '..', 'data'));
  const app = express();

  app.use(express.json({ limit: '20mb' }));
  app.use(createPortfolioRouter({ db, fetchFxRates: options.fetchFxRates }));
  app.use(createPricesRouter({
    db,
    fetchLatestPrices: options.fetchLatestPrices,
    fetchLatestAlphaPrice: options.fetchLatestAlphaPrice,
    fetchAlphaPriceOnDate: options.fetchAlphaPriceOnDate,
    fetchAlphaWeeklyHistory: options.fetchAlphaWeeklyHistory,
    searchAlphaSymbols: options.searchAlphaSymbols,
  }));

  app.use(express.static(path.join(__dirname, '..', 'dist')));
  // Express 4 catch-all for client-side routes; Express 5 requires the '/{*path}' syntax instead.
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));

  return { app, db };
}

module.exports = { createApp };
