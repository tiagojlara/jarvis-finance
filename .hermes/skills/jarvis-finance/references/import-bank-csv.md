# Importing a bank statement CSV into the cash-flow ledger

Read this when the user hands over a bank transaction CSV in the Nordic retail-bank shape
described below. Which of his banks exports in this format is in `references/import-profile.md` —
as is the rest of the personal half: which bank account is which jarvis account, which rows he
wants skipped, how incoming transfers get booked as income, and every merchant→category pair
already confirmed. Neither institution names nor personal facts belong in this file or `SKILL.md`;
both are tracked in git, the profile is not.

## Format traps (this export family)

- Semicolon-delimited, **utf-8 BOM**.
- Swedish amounts: `1.234,56` → strip thousands dots, comma → dot.
- Dates arrive as `YYYY/MM/DD` **with slashes**, which render like dashes in a terminal.
  Normalise to ISO with a regex and verify with `ascii()`/hex — never by eye.
- Confirm all of this from the bytes before parsing. Don't carry the assumptions over to another
  bank's export; re-detect delimiter, encoding and date shape per file.

## Which rows are not cash flow

- **Payments onto a card** — that spending comes in with the card statement
  (`references/import-card-statement-pdf.md`); booking the payment too counts it twice. Which
  BG/OCR numbers identify them is in the profile file.
- **Outgoing own-account transfers** — jarvis models each account's balance separately, so an
  internal move is not income or spending.
- Incoming transfers **are** income on this install, but which ones and under which category is
  the user's rule — take it from the profile file, and ask if it doesn't cover a pattern.

## Categorising

Apply the profile's confirmed merchant→category pairs. For any merchant with no pair: propose
the mapping, get an explicit OK, then append the pair **to the profile file** — never to
`SKILL.md`. Categories must be active and of the same kind as the entry; resolve their live ids
with `list_cash_flow_categories` (`entry_count` included) rather than trusting any recorded id.

## Detecting a re-import (the hard part)

Bank rows carry no unique id, and this user's imported bank entries are tagged with the
**account number**, not a statement period — so the description repeats across months and cannot
identify which import produced them. Check `(date, amount, payee)` triples against
`list_cash_flow_transactions` for the account before saving, and say how many rows you expect to
collide. Broker exports are the opposite case: their per-row id is unique and is the right guard.
The exact tag string his rows already use is recorded in the profile file — reuse it verbatim.

## Batch-write discipline

- Dry-run asserts **first**: expected per-category count map, skipped-row count, ISO date
  pattern on every kept row.
- Abort on the first save failure and print the **full** server error text — truncating it has
  hidden the real cause before; the API names the offending field.
- Read back and check count and sums against the expectations from the first bullet, then report
  both numbers, not just "done".
