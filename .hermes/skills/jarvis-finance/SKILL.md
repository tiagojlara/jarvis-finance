---
name: jarvis-finance
description: Query and maintain Tiago's local jarvis-finance portfolio via the jarvis MCP tools — holdings, transactions, dividends, FX rates, net worth, and recording manual prices, FX rates, or dividend payments. Use when asked about the portfolio, assets, cash, dividends, or currency conversions.
version: 1.1.0
platforms: [macos]
metadata:
  hermes:
    category: finance
    tags: [portfolio, mcp, personal-finance]
---

# Jarvis Finance portfolio assistant

All portfolio access goes through the `jarvis` MCP server (the local jarvis-finance
app at `http://127.0.0.1:3000/mcp`). Tools appear namespaced, e.g.
`jarvis__get_summary`, `jarvis__save_price` — check the live tool list for exact names.

## Before anything else

1. Call `get_summary`. If the MCP call fails or the connection is refused, the local
   app is not running: tell the user to start it from
   `/Users/tiago.franca/Projects/jarvis-finance` with `npm run dev` (dev) or
   `npm start` (production). Do not attempt to start it yourself, and never query
   the SQLite file directly — the API is the only supported access path.

## Ground rules (app semantics, not guesses)

- **Currency:** every amount keeps its original currency (EUR, SEK, USD, BRL).
  `get_summary` totals are per-currency and are NOT converted. To give a single-currency
  figure, fetch `list_fx_rates` and convert yourself, using the latest rate dated on or
  before the reference date; say so if rates for a date are missing.
- **Prices are snapshots, not quotes.** Each has a date and a source (Manual, Alpha
  Vantage, Marketstack, weekly close). Never present a price as live or intraday.
- **Not financial advice.** This tool is scenario tracking. Frame answers as statements
  about recorded data; no buy/sell recommendations, no return promises.
- **Never invent numbers.** If the data does not contain it, say what is missing.

## Recording manual prices (`save_price`)

- `asset_id` and currency must come from `list_assets`; the price currency must match
  the asset's own currency (it is validated — do not convert before saving).
- Use `save_price` for dated closes the user reports (a fund NAV, a broker statement).
  Re-saving the same asset + date updates the Manual row in place; provider rows are
  never overwritten by this tool, so it is safe to retry.
- Confirm the asset, date, and value with the user before saving if any of them were
  inferred from prose ("yesterday's NAV" → resolve an actual YYYY-MM-DD date first).

## Finding price history on the web (no provider symbol)

Funds like Länsförsäkringar Global Index (asset 4, SE0005188836) and Stockholm stocks like
Cibus (asset 6, CIBUS) have no working provider sync, so prices must be found and saved
with `save_price`:

- Swedish mutual funds — official/latest NAV: `https://lf.fondlista.se/sv/1/details/<ISIN>`;
  daily NAV history (~1 month, plain HTML table): `https://markets.ft.com/data/funds/tearsheet/historical?s=<ISIN>:SEK` (works with web_extract).
- Stockholm-listed stocks — FT tearsheets 404; use Yahoo's chart API via terminal curl:
  `https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>.ST?range=3mo&interval=1d` (no auth needed with a browser User-Agent). Verify plausibility against an existing manual row.
- Fund NAVs publish T+1 (bryttid 15:00); the "latest" is usually yesterday's date. For same-day stock closes, check `regularMarketTime` vs Stockholm close (17:30 CET) before treating an intraday value as a close.
- Pitfall: NAVs get recorded one day late easily (a NAV published on day X is day X-1's close). Verify the date column, not the publish date.
- Batch backfills (>15 rows): don't spend one tool_call per row — POST JSON-RPC straight to the jarvis MCP endpoint (`http://127.0.0.1:3000/mcp`, streamable HTTP: initialize → notifications/initialized → tools/call `save_price`, tool names un-namespaced, Mcp-Session-Id header). See scratch pattern: assert each response's date/price, then read back with `list_prices`.

## Recording dividends (`save_dividend`)

`save_dividend` writes an actual dividend payment into the investment dividend ledger — the same
rows the UI dividend dialog creates, and the same rows `list_dividends` reads back.

- Params: `asset_id` + `date` + `amount` required; `account_id`, `shares`, `notes` optional.
  Currency defaults to (and must match) the asset's own currency — do not convert before saving.
  `asset_id`/`account_id` come from `list_assets`/`list_accounts`.
- Idempotent per asset + date: re-saving the same amount returns `action: 'exists'` and creates
  no duplicate — safe to retry after an unclear response.
- A DIFFERENT amount for an already-recorded asset + date is refused: that row may be the user's
  own entry. Ask first; after the user confirms the correction, re-call with `replace=true`
  (it updates the row in place and keeps notes/shares unless you pass new ones).
- Always verify by reading back with `list_dividends`, and mention the recorded date + amount.
- Dividends live in the investment ledger ONLY: never also enter them into the app's Cash Flow
  page (manual-only, not exposed over MCP) — that would double-count the income there.

- Convention: record on the PAY date (when Nordnet settles), amount = the actual SEK settlement
  from the user's Nordnet CSV/app — published per-share web figures (stockanalysis, fiscal.ai,
  mfn.se) differ from Nordnet's settlement by ±1-2% because Nordnet converts EUR→SEK at its own
  rate. Use web sources only to identify which dividend was paid (ex-date/pay-date/per-share);
  ask the user for the settlement amount rather than estimating.
- Cibus pays MONTHLY (ex-date ~25th/26th, pay ~3rd/8th); declared in EUR (~€0.07-0.08/share).

## Recording FX rates (`save_fx_rate`)

- Upserts by (date, base, quote) and stores source as Manual; a later provider sync in
  the app will not overwrite Manual rows.
- Follow the app's pair direction: base EUR (for example EUR→SEK), not the inverse,
  unless the user explicitly gives the other direction. Check existing pairs with
  `list_fx_rates` first.

## Answering style

- Quantities with 2 decimals, money with the currency code after the amount (12 500 EUR).
- When comparing across accounts/assets, prefer `get_summary` over re-summing raw
  `list_transactions` rows.
- For net-worth questions use `get_net_worth`: physical asset valuations and loan
  balances are dated manual snapshots — quote their dates.
