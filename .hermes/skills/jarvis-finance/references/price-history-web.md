# Finding dated prices on the web, and batch-writing them

Read this when an asset has no usable provider symbol and a dated NAV or close has to be found
on the web and saved with `save_price` — Swedish mutual funds and small Stockholm-listed names
are the usual cases. `references/import-profile.md` lists which of this user's assets need that
and their identifiers. Nothing personal belongs in `SKILL.md`.

## Sources

- **Swedish mutual funds** — latest/official NAV: `https://lf.fondlista.se/sv/1/details/<ISIN>`.
  Daily NAV history (~1 month, plain HTML table, works with `web_extract`):
  `https://markets.ft.com/data/funds/tearsheet/historical?s=<ISIN>:<CCY>`.
  The FT tearsheet takes **any** ISIN + currency, not just local ones — including
  foreign-domiciled funds (e.g. a Luxembourg share class as `?s=LU…:USD`).
- **Stockholm-listed stocks** — FT tearsheets 404 for these. Use Yahoo's chart API via terminal
  curl: `https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>.ST?range=3mo&interval=1d`
  (no auth needed with a browser User-Agent). Check plausibility against an existing manual row
  before saving.

## Traps

- Fund NAVs publish **T+1** (Swedish *bryttid* 15:00), so the "latest" is usually yesterday's
  date. A NAV published on day X is normally day X−1's close — verify the **date column**, never
  the publish date. This is how prices get recorded a day late.
- For same-day stock closes, compare `regularMarketTime` against the exchange's close
  (Stockholm 17:30 CET) before treating an intraday value as a close.
- `web_extract` sometimes **drops the date column** from the FT table. Anchor dates against
  known values (an existing manual price, or a transaction's `unit_price`) before saving
  anything.

## Batch backfills (>15 rows): the raw MCP endpoint

One tool call per row wastes the turn. POST JSON-RPC straight to
`http://127.0.0.1:3000/mcp` — Streamable HTTP:

1. `initialize` → read the `Mcp-Session-Id` **response header**.
2. `notifications/initialized` with that session id.
3. `tools/call` — tool names are **un-namespaced** here (`save_price`, not `jarvis__save_price`),
   and `Mcp-Session-Id` goes on every subsequent call.
4. `Accept: application/json, text/event-stream` is required or the server refuses.
5. Responses come back as SSE — parse the `data: ` lines.

Assert each response's date and price, then read back with `list_prices` and compare the count
and the values before reporting success.
