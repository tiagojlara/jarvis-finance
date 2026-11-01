# Northstar · Personal portfolio planner

A local-first personal investment tracker and retirement planning tool. It is for tracking and scenario exploration, not financial advice, and it does not trade.

The interface uses React components, Recharts for responsive interactive charts, Vite for the local development server and production bundle, and Tailwind CSS v4 through its Vite plugin. The API remains a local Express server backed by SQLite.

## Requirements and setup

- Node.js 20.19 or later and npm (Vite's current release requires a recent Node runtime).
- On Apple Silicon, check `node -p "process.arch"`; it should print `arm64`. If the shell still finds an Intel Node first, run `export PATH="/opt/homebrew/opt/node/bin:$PATH"` in that terminal, then open a new terminal or add the same line to `~/.zprofile`.
- From this folder, run `npm install`, then `npm run dev`.
- Open [http://localhost:5173](http://localhost:5173). The browser UI and SQLite API both bind to localhost.
- Run `npm test` for the calculation tests. To create a production bundle, run `npm run build`, then `npm start` and open [http://localhost:3000](http://localhost:3000).
- React components and shared API helpers live under `src/client/`; Vite builds them into `dist/`, which Express serves in production.

No cloud account, telemetry, or analytics are configured. Prices can be entered manually or fetched on request from the optional Alpha Vantage provider; Marketstack remains available as a fallback. Historical FX sync uses the selected Frankfurter source only when you request a sync; it sends the currency list and a date range, never holdings or amounts. The interface uses system fonts and does not load third-party assets.

To enable Alpha Vantage, copy `.env.example` to `.env`, set `ALPHA_VANTAGE_API_KEY`, and restart the server. The `.env` file is ignored by Git and is not included in backups or sent to the browser. Alpha Vantage documents a free allowance of 25 requests per day; symbol searches and one-symbol quote requests both count against the local daily counter. Global Quote is end-of-day by default on the free tier and is not a live quote. Edit an asset and use **Search Alpha Vantage symbols** to choose a listing and its quote currency; only the name or ticker used in that explicit search is sent. The provider may not cover every fund or exchange. Manual prices remain available. Set `MARKET_DATA_PROVIDER=marketstack` and use `MARKETSTACK_API_KEY` to switch back; existing Marketstack symbols are retained.

## Data and currencies

The SQLite database is `data/portfolio.sqlite` (override the directory with `DATA_DIR`). Back up regularly using **Settings & backup → Download full backup**. Restore replaces the records in the database. CSV export includes the current holdings summary. Keep exported backups private; they contain financial details.

EUR, SEK, USD, and BRL are supported. Transactions, prices, and dividends retain their original currency. The home currency can be changed from the overview or retirement assumptions. Enter dated exchange rates manually, or select Frankfurter blended or its ECB reference source and choose **Sync historical FX rates**. Sync stores daily EUR-based rates locally for the date range from the earliest activity through today; the app derives cross-rates as needed. Frankfurter requires no API key, charges no fee, publishes daily historical reference rates, and has no daily or monthly quotas, though it may throttle abusive request volume. Rates are not live trading quotes. Dashboard conversions use the latest rate on or before the valuation date. If rates are missing, combined home-currency valuation is marked incomplete. See [Frankfurter's API docs](https://frankfurter.dev/) for current provider details.

## Prices and portfolio calculations

Prices are dated entries with a source label. Marketstack and Alpha Vantage prices are end-of-day and never described as live; manual entries remain available and are not replaced by a Marketstack quote for the same date. A full price sync requests quotes only for assets with open positions; fully sold assets are skipped to save the daily allowance, unless you explicitly select one. The selected overview currency is applied to current totals and historical portfolio values. Historical chart points are computed from holdings on each transaction, dividend, and price date, using the most recent price and FX rate on or before that date. A date is omitted if any open holding lacks a price or conversion rate. The chart only represents invested holdings; cash not modeled as a cash asset is excluded. To build a meaningful trend, enter dated price snapshots over time and sync or enter matching FX rates. Multiple purchases are separate transactions. Cost basis uses moving weighted-average cost: purchase value plus fees increases basis, each partial sale removes the current average basis for the shares sold, and sale fees reduce realized proceeds. Unrealized gain/loss is current value minus remaining cost basis; realized gain is tracked in calculations but is not yet surfaced in the interface. Dividends are actual entries only; monthly history shows only recorded payments. Yield and dividend-growth metrics are omitted because there may not be enough history to calculate them responsibly.

## Retirement assumptions

Scenario values are illustrative nominal estimates using monthly contributions and annual return assumptions. They exclude tax, investment costs, and any return variability. Inflation is editable but displayed separately; it does not increase contributions in this version. The displayed income reference uses a simple 4% of projected assets per year divided by twelve; it is not a sustainable-income promise. Forecasts can differ greatly from actual results. Keep assumptions editable and avoid treating outputs as guarantees.

## Scope notes

The app supports accounts, assets, buy/sell and cash-flow transactions, dated account or Cash-asset balance snapshots without trades, dated manual or optional Alpha Vantage or Marketstack prices, a dedicated dividend history page, manual FX rates, allocation, responsive Recharts visualizations, ROI and selectable history periods, projections, backup/restore, and CSV export. Brokerage integrations, taxes, bonds' accrued interest, corporate actions, and full cash-account reconciliation are not included. Use demo data only if you explicitly select it; it is labeled and removable through the account/asset and activity screens.


Cash balances are dated snapshots linked either to an account directly or to a Cash-type asset. Use one tracking method per account to avoid double-counting; a cash asset must use the account currency. The latest snapshot per account/cash asset contributes to current value, and historical charts use the most recent snapshot on or before each date. Period return is the change between the first and last portfolio valuations in the selected range; it is not adjusted for deposits or withdrawals. Unrealized ROI is unrealized gain divided by remaining cost basis, excluding cash and realized gains.

## Physical assets and loans

Use **Net worth** to record property, vehicles, and other physical assets, then add dated manual valuations. Loans and mortgages are separate records and can link to a physical asset; record dated remaining-balance snapshots as you receive statements. The net-worth estimate combines the current investment/cash total with the latest physical valuations and subtracts latest recorded loan balances. It uses stored FX rates as of each record date and indicates when prices or rates are missing. These amounts are manual snapshots, not appraisals, amortization schedules, or live lender balances. Linked loans must use the physical asset's currency so the displayed asset equity is meaningful. Physical assets and debt do not enter investment ROI or retirement projections. These tables are included in full JSON backups.
