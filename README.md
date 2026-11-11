# Tamanduá Finance

<p align="center">
  <img src="public/tamandua-logo.png" alt="Logo Tamanduá" width="520">
</p>

**A private, local-first workspace for understanding your finances and exploring your financial future.**

Track investments, cash flow, net worth, and retirement scenarios in one place. Tamanduá runs on your computer, stores its data in a local SQLite database, and does not trade or provide financial advice.

## What you can do

- **Track your portfolio:** organize accounts and assets, record transactions and dividends, and enter dated prices manually.
- **Understand your cash flow:** record income and spending by account and category, with totals kept in each account's currency.
- **See your net worth:** combine investments and cash with manually valued property, vehicles, and loans.
- **Explore retirement scenarios:** adjust contributions, returns, and inflation assumptions to see illustrative projections.
- **Ask questions and manage records:** optionally connect a compatible model endpoint to use the full local MCP toolset, including record changes.
- **Work across currencies:** use EUR, SEK, USD, and BRL, with optional historical exchange rates from Frankfurter.

## Privacy by default

Your financial records stay in a local SQLite database. The app does not use analytics, connect to a price feed, or send data to a cloud service by default. Historical exchange-rate sync sends only the currencies and date range requested. The optional assistant sends your question, conversation context, and relevant records to the model endpoint you configure; you choose whether to enable it.

Backups and exports contain personal financial information. Keep them private. See **Settings & backup** in the app to download or restore a backup.

## Get started

Requires Node.js 20.19 or newer and npm.

```sh
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The app and its API listen on this computer only. No `.env` file or cloud account is required.

To run a production build locally:

```sh
npm run build
npm start
```

## Optional: connect an MCP agent

Tamanduá includes a local MCP endpoint at `http://127.0.0.1:3000/mcp` for compatible agents. It can read portfolio data and record selected routine entries, including manual prices and cash-flow transactions. It is unauthenticated and intended for local use; only connect agents you trust. If an agent uses a cloud model, information returned by its tools may be sent to that model provider.

## Scope and assumptions

Tamanduá is for personal tracking and scenario exploration, not investment, tax, or financial advice. Prices and asset valuations are manual snapshots; exchange rates are historical reference rates, not live trading quotes. Projections are illustrative and exclude taxes, costs, and market variability. Brokerage connections, bank syncing, and automatic price feeds are not included.

For technical details about the local API, assistant behavior, data model, and MCP tools, see the corresponding source files in `src/`.
