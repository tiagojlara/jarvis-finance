---
name: tamandua
description: Query and maintain the user's local tamandua portfolio via the tamandua MCP tools — holdings, transactions, dividends, FX rates, net worth, the cash-flow income/spending ledger, and recording manual prices, FX rates, dividend payments, or cash-flow entries. Use when asked about the portfolio, assets, cash, dividends, income, spending, or currency conversions.
version: 1.4.0
platforms: [macos]
metadata:
  hermes:
    category: finance
    tags: [portfolio, mcp, personal-finance]
---

# Tamanduá Finance portfolio assistant

All portfolio access goes through the `tamandua` MCP server (the local tamandua
app at `http://127.0.0.1:3000/mcp`). Tools appear namespaced, e.g.
`tamandua__get_summary`, `tamandua__save_price` — check the live tool list for exact names.

## Where personal facts live (read before editing this skill)

This file is **method only** — it should still read correctly for somebody else's tamandua
install. Person-specific facts never go here, and are never restated here: real names, family
members, account/asset/category **ids**, bank or card numbers, which categories this user
retired or invented, merchant→category mappings, and any "the user always/never does X" rule.

Those live in `references/import-profile.md` **in this skill folder**
(`${HERMES_SKILL_DIR}/references/import-profile.md`), which is also the only place to write
them: append the fact there, in the matching section, instead of adding a bullet to this file.
Read it before touching spending, income, imports or dividends.

- If that file does not exist (a fresh clone — it is gitignored, deliberately), create it by
  asking the user the questions it is organised around. Do not "solve" a missing profile by
  writing the answers into this skill.
- Technique that generalises → this file. Fact about this person's data → the profile file.
- `SKILL.md` and every `references/` file **except the profile** are committed to git and meant
  to be shared, so they name no institutions, issuers or brokers either: describe a format by its
  shape ("a Nordic retail-bank CSV", "a two-column card invoice PDF"), and let the profile's
  source→recipe table say who produces it. Same for the exact tag and notes strings an import
  writes — those are already in this user's rows, so they are personal data.
- Three destinations, by who they help: a fact about **this person's** data → the profile file.
  Detail about **one format or task** (a CSV's columns, a PDF's layout, a website's quirks) → a
  topic file under `references/`, listed below. Something true of **every** tamandua conversation
  → this file, written impersonally. Length here is paid for by every session; length in a
  reference file is paid for only by the sessions that open it.
- The profile records **names, not ids**: this user edits accounts and categories in the tamandua
  UI between runs, so resolve every id live (`list_accounts`, `list_cash_flow_categories`,
  `list_assets`) and trust the tool over anything written down, including this skill.

## Before anything else

1. Call `get_summary`. If the MCP call fails or the connection is refused, the local app is not
   running: tell the user to start it from the project root — `${HERMES_SKILL_DIR}/../..`, since
   this skill ships inside the repo — with `npm run dev` (dev) or `npm start` (production). Do
   not start it yourself, and never query the SQLite file directly: the API is the only supported
   access path.
2. For anything involving spending, income, imports or dividends, read
   `${HERMES_SKILL_DIR}/references/import-profile.md` for the user's accounts, category choices
   and merchant mappings — then resolve the ids it names against the live tools.

## Reference files (read the one the task needs)

Only this file is always in view. The rest load on demand — `read_file` on
`${HERMES_SKILL_DIR}/references/<name>` or `skill_view(name, file_path=...)`:

| File | Open it when |
| --- | --- |
| `references/import-profile.md` | **before any** import, categorisation or dividend — the user's accounts, category choices, merchant pairs and preferences (personal, gitignored) |
| `references/import-card-statement-pdf.md` | a credit-card invoice PDF arrives |
| `references/import-bank-csv.md` | a bank transaction CSV arrives |
| `references/import-broker-export.md` | a broker transactions-and-notes export arrives |
| `references/price-history-web.md` | a fund NAV or stock close must be found online, or a long price backfill is being written |

New depth goes into the matching topic file, not into this one — and if you create a new topic
file, add a row to the table above, or no future session will know to open it.

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

Some holdings have no usable provider symbol, so their prices must be found on the web and saved
with `save_price`. Which assets those are on this install is in the profile file; the sources,
the T+1 date traps and the raw-MCP batch-backfill handshake are in
`references/price-history-web.md` — read it before hunting for a price, and remember a saved
price is a dated snapshot, never a quote.

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
- Dividends live in the investment ledger ONLY: never ALSO book the same payment with
  `save_cash_flow_entry` — cash flow would double-count that income. Exception: only when the
  user has asked for it (it would be recorded in the profile file), summarise monthly dividend
  income as ONE `save_cash_flow_entry` income row per month per currency (e.g. category
  "Dividends") over what `list_dividends` already holds, and say so in the answer — never one
  entry per payment.

- Convention: record on the date the **broker settles** (the pay date), at the actual settlement
  amount in the account currency. Published per-share figures are converted at the broker's own
  rate and run ±1-2% off, so use web sources only to identify *which* dividend was paid, and ask
  the user for the amount instead of estimating.
- Per-asset payout cadence (monthly vs quarterly, ex/pay dates, declared currency) and the
  settlement convention for a specific broker are facts about the user's holdings: they live in
  `references/import-profile.md` and `references/import-broker-export.md`, not here.

## Cash-flow ledger (`get_cash_flow_summary`, `save_cash_flow_entry`, ...)

The Cash Flow ledger is the user's own record of income and spending, kept separate from the
investment ledger: entries never change holdings, dividends, or net worth, and portfolio
activity never generates them. It shows only what was recorded — absence is not evidence of
no spending. Tools: `get_cash_flow_summary` (one month, per currency), `list_cash_flow_transactions`
(filtered, newest first), `list_cash_flow_categories`, `save_cash_flow_entry`,
`update_cash_flow_entry`, `delete_cash_flow_entry`, `save_cash_flow_category`,
`update_cash_flow_category`.

- For "how much did I spend this month?" use `get_cash_flow_summary` with `month=YYYY-MM`
  (defaults to the current month). Totals are per currency and NOT converted — never add
  EUR and SEK amounts together; convert with `list_fx_rates` yourself and say you did.
- `save_cash_flow_entry` needs `account_id`, `category_id`, `kind`, `date`, `amount`.
  The entry's currency is ALWAYS the account's currency — pick the account that was actually
  used (list_accounts; a SEK card means a SEK account entry, never convert first). The
  category must be active and of the same kind as the entry; these are validated exactly like
  the app's own form.
- It is NOT idempotent: every call adds a row, and buying coffee twice in a day is legitimate.
  After an unclear response, check `list_cash_flow_transactions` before re-saving — do not
  assume a retry is safe.
- Only save what the user (or a statement they provide) actually states: an amount, a date, and
  which account paid. Confirm those before writing; never estimate or auto-categorize spending.
- `update_cash_flow_entry` and `delete_cash_flow_entry` work by id from the list output.
  Show the date/amount/category and get an explicit yes before deleting.
- Categories: reuse the defaults when one fits (`list_cash_flow_categories`, which includes
  `entry_count`); `save_cash_flow_category` is idempotent per name + kind and returns
  `{action, category:{id,...}}` (unwrap `.category.id`). Retire a used
  category with `update_cash_flow_category` `active=false` — used categories cannot change kind
  and are never deleted, so history stays categorized.
- Which categories this user actually uses — and which seeded defaults were deliberately
  retired — is in `references/import-profile.md`. Never assume the defaults are all live, and
  never add a personal taxonomy to this skill; `list_cash_flow_categories` gives the current set.
- Pitfall: the user edits entries and categories directly in the tamandua UI between agent runs.
  Never batch-update from remembered or hardcoded state — re-fetch `list_cash_flow_transactions`
  live, select by current `category_id`, and trust what the tool returns over earlier assumptions.

## Importing statements and exports

Every import starts the same way: read `references/import-profile.md` for the personal half
(which statement belongs to which account, which rows are not spending, how transfers are booked,
which merchant pairs are already confirmed), then open the recipe for the format at hand —
`references/import-card-statement-pdf.md`, `references/import-bank-csv.md` or
`references/import-broker-export.md`. Those files carry the per-format detail — column layouts,
label strings, encoding traps — described by **shape, not by issuer**: which bank, card or broker
produces that shape, and the literal tag strings already written into this user's rows, belong in
the profile, because everything except the profile is committed. This section holds only the
invariants that hold for any format:

- **Names, never remembered ids.** Resolve accounts, categories and assets live — this user
  edits them in the tamandua UI between runs, so a written-down id is a hypothesis.
- **Checksum before writing,** against the statement's own totals, to the smallest currency
  unit. A mismatch means re-parse; never write first and reconcile later.
- **Transfers are not spending.** Payments onto a card, own-account moves and internal broker
  transfers get skipped, or the same money is counted twice.
- **Never silently auto-categorise.** Use pairs the user already confirmed; propose the rest,
  get an explicit OK, then append the new pair **to the profile file**.
- **Guard against a re-import before writing,** with `list_cash_flow_transactions`: neither
  `save_cash_flow_entry` nor the REST endpoints are idempotent. A description tag only works as a
  guard if it is unique per statement — broker exports are (per-row id), bank rows often are not,
  so match `(date, amount, payee)` there. Use the tag strings the profile records verbatim.
- **Batch long writes** through the raw MCP endpoint rather than one tool call per row
  (handshake in `references/price-history-web.md`), and on REST failures print the **full**
  server error — it names the offending field, and truncating it has hidden the cause before.
- **Read back and report** entry count and sums against the statement. "Done" without a read-back
  is not a result.

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
