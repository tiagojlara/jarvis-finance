# Importing a broker export into the investment ledger

Read this when the user provides a `transactions-and-notes-export.csv`-style export from a
**Swedish online broker** — the Swedish column labels below are that export family's, not
universal. Personal facts live in `references/import-profile.md` and not here: which tamandua
account is the brokerage, the broker's name, the exact `notes` strings his already-imported rows
use, which assets are foreign-domiciled funds, a holding's payout cadence. This file is tracked
in git, the profile is not.

## Reading the file

UTF-16-LE, TAB-delimited, Swedish comma decimals. Parse with `encoding='utf-16'`, `split('\t')`,
and `float(s.replace('.','').replace(',','.'))`.

| Column | Meaning |
| --- | --- |
| `Id` | export row id — the duplicate-import guard |
| `Bokföringsdag` / `Likviddag` | booking date / settlement (cash) date |
| `Transaktionstyp` | `KÖPT`, `SÅLT`, `UTDELNING`, `UTTAG INTERNT`, … |
| `Värdepapper` / `ISIN` | name / identifier |
| `Antal`, `Kurs` | quantity, price **in the asset's currency** |
| `Belopp` | settlement amount in the account currency (SEK) |
| `Inköpsvärde` | cost basis, asset currency |
| `Totalt antal` | running quantity after the row |
| `Saldo` | settled cash after the row |
| `Växlingskurs` | FX rate applied |
| `Notanummer` | note reference (`FM-…`) |

## Where the writes go

**No MCP tool creates assets, transactions or cash balances.** Use the app's generic REST API:
`POST http://127.0.0.1:3000/api/{assets|transactions|prices|cash_balances}` — field lists in
`src/db.js` `TABLE_FIELDS`, validation in `src/routes/portfolio.js`. Buy/sell requires
`quantity > 0`, `unit_price > 0`, `asset_id`, and `currency` equal to the asset's currency.

- **KÖPT / SÅLT** — create the asset first when the ISIN is new (`ticker` = ISIN, a note saying
  it came from the export plus the identifier). Then POST the transaction: `date` =
  `Bokföringsdag`, `quantity` = `Antal`, `unit_price` = `Kurs`, `amount` = 0, `fees` = 0,
  `currency` = asset currency, and notes carrying the export row id, the type, the settlement and
  — when the row has one — the note reference. Reuse **the exact notes shape recorded in the
  profile file**, because that id-in-notes string is what the double-import guard greps for; a
  reworded variant silently finds nothing. Keep the broker's sign on the settlement amount and
  the Swedish decimal comma inside the notes string — it is prose, not a number.
- **UTDELNING** — check `list_dividends` for the same asset + amount first: settlements the user
  already reported are often recorded. Skip duplicates, else `save_dividend` on the **pay** date
  (`Likviddag`). Record the actual settlement in the account currency, not a per-share web
  figure converted by hand — the broker applies its own FX, so published numbers differ by
  roughly ±1-2%. Use web sources only to work out *which* dividend was paid.
- **UTTAG INTERNT and other internal transfers** — not an asset transaction; skip them and let
  the brokerage cash balance reflect the move.
- **KÄLLSKATT** (source tax withheld on a dividend) appears in some exports. It is not documented
  here as buy, sell or dividend — if the export contains it, ask the user how withholding should
  be represented (its own row, or folded into the `UTDELNING` amount) before creating anything,
  and record the answer in the profile file.
- **`Saldo`** gives settled cash in the account currency: record it with
  `POST /api/cash_balances` `{account_id, date, balance, currency, notes}`, resolving the
  brokerage's `account_id` live by name from `list_accounts`. Mind settlement lag — a `KÖPT`
  row's `Saldo` can already reflect a *future* `Likviddag`; if so, record the last same-day
  settled `Saldo` and note the pending amount in `notes`.

## Checksums before writing anything

- `Antal × Kurs × Växlingskurs ≈ |Belopp|` per row.
- `Totalt antal` must equal prior holdings ± the row's quantity.
- The `Saldo` chain must reconcile row to row.
- Guard against a double import by searching existing transactions' notes for these export row
  ids before creating anything.

Fund NAVs for foreign-domiciled funds in the export: see
`references/price-history-web.md` for sourcing and saving dated prices.
