# Jarvis Finance · Personal portfolio planner

A local-first personal investment tracker and retirement planning tool. It is for tracking and scenario exploration, not financial advice, and it does not trade.

The interface uses React components, Recharts for responsive interactive charts, Vite for the local development server and production bundle, and Tailwind CSS v4 through its Vite plugin. The API remains a local Express server backed by SQLite.

## Requirements and setup

- Node.js 20.19 or later and npm (Vite's current release requires a recent Node runtime).
- On Apple Silicon, check `node -p "process.arch"`; it should print `arm64`. If the shell still finds an Intel Node first, run `export PATH="/opt/homebrew/opt/node/bin:$PATH"` in that terminal, then open a new terminal or add the same line to `~/.zprofile`.
- From this folder, run `npm install`, then `npm run dev`.
- Open [http://localhost:5173](http://localhost:5173). The browser UI and SQLite API both bind to localhost.
- Run `npm test` for the calculation tests. To create a production bundle, run `npm run build`, then `npm start` and open [http://localhost:3000](http://localhost:3000).
- React components and shared API helpers live under `src/client/`; Vite builds them into `dist/`, which Express serves in production.

No cloud account, telemetry, or analytics are configured. Asset prices are entered manually — through the price dialog or recorded by an MCP agent — and the app never calls a price provider. Historical FX sync uses the selected Frankfurter source only when you request a sync; it sends the currency list and a date range, never holdings or amounts. The interface uses system fonts and does not load third-party assets.

No `.env` is required for normal use: the file is still supported for `PORT` and `DATA_DIR` if you want to override them, and is ignored by Git.

## MCP server for external agents (optional)

The API also serves a Model Context Protocol (MCP) endpoint at `/mcp` (Streamable HTTP, JSON-RPC) so agents that speak MCP — for example [Nous Research Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) — can read the portfolio and record routine entries with their own tools. Nothing needs configuring: no token, no environment variable. It listens only where the app itself listens (`127.0.0.1`, port 3000 in dev and production), so any local process on this machine can reach it and nothing off-machine can. Treat local-disk access as the trust boundary.

The exposed tools are read views (`get_summary`, `list_accounts`, `list_assets`, `list_transactions`, `list_dividends`, `list_prices`, `list_fx_rates`, `list_cash_balances`, `get_net_worth`) and exactly three writes: `save_price` records a dated **Manual** price and replaces only another Manual row for the same asset and date, never a provider-sourced row; `save_fx_rate` upserts a dated Manual FX rate, which later provider syncs will not overwrite (matching the Manual-wins rule used by the UI); `save_dividend` records a dated dividend payment like the UI dialog — it is idempotent per asset + date (a repeat of the same amount returns the existing row) and refuses to overwrite an already-recorded amount unless the caller passes `replace: true` after confirming with the user. Accounts, assets, transactions, cash balances, physical assets, loans, the cash-flow ledger, settings, backup, and restore are not writable through MCP.

Point Hermes at it with a config entry like:

```yaml
mcp_servers:
  jarvis:
    url: http://127.0.0.1:3000/mcp
```

This repository also ships a Hermes **skill** at `.hermes/skills/jarvis-finance/SKILL.md` that teaches agents the app's semantics before they touch the tools: per-currency totals are never pre-converted, prices are dated snapshots and never live quotes, Manual rows are replaced but provider rows never are, and answers stay scenario tracking, not advice. Hermes discovers project-local skills when it works in this folder (after you grant the folder trust); to make the skill available in every Hermes session regardless of working directory, copy it into the global tree: `cp -R .hermes/skills/jarvis-finance ~/.hermes/skills/`. Skills install by folder copy — there is no separate build step, and MCP servers themselves are configured in Hermes' `config.yaml`, not bundled inside plugins.

Privacy note: this endpoint sends nothing out by itself. What leaves the machine is whatever the agent's **model** does with tool results — ask an agent backed by a cloud model about your holdings and those numbers travel to that provider. Paired with a local model (Ollama/vLLM), the loop stays entirely on the machine. Hermes-side tool filters (see its MCP config reference) can further restrict what the agent may call.

## Data and currencies

The SQLite database is `data/portfolio.sqlite` (override the directory with `DATA_DIR`). Back up regularly using **Settings & backup → Download full backup**. Restore replaces the records in the database. CSV export includes the current holdings summary. Keep exported backups private; they contain financial details.

EUR, SEK, USD, and BRL are supported. Transactions, prices, and dividends retain their original currency. The home currency can be changed from the overview or retirement assumptions. Enter dated exchange rates manually, or select Frankfurter blended or its ECB reference source and choose **Sync historical FX rates**. Sync stores daily EUR-based rates locally for the date range from the earliest activity through today; the app derives cross-rates as needed. Frankfurter requires no API key, charges no fee, publishes daily historical reference rates, and has no daily or monthly quotas, though it may throttle abusive request volume. Rates are not live trading quotes. Dashboard conversions use the latest rate on or before the valuation date. If rates are missing, combined home-currency valuation is marked incomplete. See [Frankfurter's API docs](https://frankfurter.dev/) for current provider details.

## Prices and portfolio calculations

Prices are dated entries with a source label. Asset prices are recorded manually now: add them in the price dialog, or let an MCP agent (like Hermes, see **MCP server**) save dated closes from your broker statement or a fund's published NAV. The app no longer contacts price providers; rows previously imported with provider labels (Alpha Vantage, Marketstack, "weekly close") stay in the database, keep valuing holdings, and are never rewritten or fetched over. The selected overview currency is applied to current totals and historical portfolio values. Historical chart points are computed from holdings on each transaction, dividend, and price date, using the most recent price and FX rate on or before that date. A date is omitted if any open holding lacks a price or conversion rate. The chart only represents invested holdings; cash not modeled as a cash asset is excluded. To build a meaningful trend, enter dated price snapshots over time and sync or enter matching FX rates. Multiple purchases are separate transactions. Cost basis uses moving weighted-average cost: purchase value plus fees increases basis, each partial sale removes the current average basis for the shares sold, and sale fees reduce realized proceeds. Unrealized gain/loss is current value minus remaining cost basis; realized gain is tracked in calculations but is not yet surfaced in the interface. Dividends are actual entries only; monthly history shows only recorded payments. Yield and dividend-growth metrics are omitted because there may not be enough history to calculate them responsibly.

## Retirement assumptions

Scenario values are illustrative nominal estimates using monthly contributions and annual return assumptions. They exclude tax, investment costs, and any return variability. Inflation is editable but displayed separately; it does not increase contributions in this version. The displayed income reference uses a simple 4% of projected assets per year divided by twelve; it is not a sustainable-income promise. Forecasts can differ greatly from actual results. Keep assumptions editable and avoid treating outputs as guarantees.

## Scope notes

The app supports accounts, assets, buy/sell and deposit/withdrawal/fee transactions, a manual cash-flow income-and-spending ledger (see **Cash flow**), dated account or Cash-asset balance snapshots without trades, dated manual prices (UI or MCP), a dedicated dividend history page, manual FX rates, allocation, responsive Recharts visualizations, ROI and selectable history periods, projections, backup/restore, and CSV export. Brokerage integrations, automatic price-provider sync (removed November 2026 — manual entry and the MCP `save_price` tool replace sync, backfill, symbol search, and NAV file import), bank syncing or statement import for cash flow, taxes, bonds' accrued interest, corporate actions, and full cash-account reconciliation are not included. Use demo data only if you explicitly select it; it is labeled and removable through the account/asset and activity screens.


Cash balances are dated snapshots linked either to an account directly or to a Cash-type asset. Use one tracking method per account to avoid double-counting; a cash asset must use the account currency. The latest snapshot per account/cash asset contributes to current value, and historical charts use the most recent snapshot on or before each date. Period return is the change between the first and last portfolio valuations in the selected range; it is not adjusted for deposits or withdrawals. Unrealized ROI is unrealized gain divided by remaining cost basis, excluding cash and realized gains.

## Cash flow

The **Cash flow** page tracks income and spending in a ledger that is deliberately separate from the investment ledger. Entries use the same accounts as the portfolio — a brokerage, bank, or card account can hold investments and cash-flow records side by side; there is no separate cash-account list. Each entry has a date, income/expense type, amount, category, and account, with optional payee and description. Entries never create buy/sell activity and never change holdings, dividends, or net worth — and investment transactions never generate cash-flow entries, because the app cannot know whether a sale's proceeds were spent. Amounts stay in each account's currency, and totals (income, spending, net) are reported per currency without conversion; currency switching is a planned follow-up once rates are available for the entry dates. The default view is one month with prev/next navigation; the entry list can be filtered by account, type, category, and all time. Default categories (Salary, Housing, Food, Transport, and so on) are seeded only while the category table is empty, so renaming or clearing them is never silently reverted. Add, rename, or deactivate categories yourself; a category with entries is deactivated rather than deleted so history stays categorized. Everything is entered manually — no bank sync, statement import, budgets, recurring entries, or agent-driven writes — and the ledger shows only recorded activity, not complete account movement. Cash-flow tables are included in full JSON backups and restore cleanly; older backups without them restore as usual and regain the default categories.

## Physical assets and loans

Use **Net worth** to record property, vehicles, and other physical assets, then add dated manual valuations. Loans and mortgages are separate records and can link to a physical asset; record dated remaining-balance snapshots as you receive statements. The net-worth estimate combines the current investment/cash total with the latest physical valuations and subtracts latest recorded loan balances. It uses stored FX rates as of each record date and indicates when prices or rates are missing. These amounts are manual snapshots, not appraisals, amortization schedules, or live lender balances. Linked loans must use the physical asset's currency so the displayed asset equity is meaningful. Physical assets and debt do not enter investment ROI or retirement projections. These tables are included in full JSON backups.
