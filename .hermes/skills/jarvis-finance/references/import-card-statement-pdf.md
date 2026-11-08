# Importing a card statement PDF into the cash-flow ledger

Read this when the user hands over a credit-card invoice PDF whose transaction tables print
**side by side** (the usual two-column layout). **Personal facts are not here** — which card maps
to which jarvis account, whose supplementary cards appear on the same invoice, the confirmed
merchant→category pairs, and the exact statement-tag string his existing rows carry — all of that
is in `references/import-profile.md`. No institution name belongs in this file either: it is
tracked in git, the profile is not.

## Procedure

1. Read the profile file, then resolve the destination account by **name** with `list_accounts`.
   Never a remembered id — this user renumbers accounts between runs.
2. Extract with pdfplumber `extract_text(layout=True)`. `read_file`'s auto-extract scrambles the
   side-by-side two-column transaction tables and desyncs amounts from merchants. Note that
   pdfplumber lives on `/usr/bin/python3`, not in the code-execution sandbox — run it from the
   terminal.
3. Parse to (transaction date, payee, settled amount).
4. **Checksum before writing:** each cardholder section and the grand total must equal the
   statement's own total rows (labelled `Summa` on Swedish invoices) to the smallest unit. If
   they don't, stop and re-parse — do not write and fix later.
5. Save the settled statement-currency column (`Belopp`) as-is: it already includes the
   foreign-currency fee. Never the original foreign amount.
6. Skip the payment *onto* the card (`Inbetalningar`, negative CR) — it is a transfer, and importing
   it counts the spending twice. Supplementary-card purchases belong to the same jarvis account
   as the main cardholder's, tagged in the description.
7. Categorise from the profile's confirmed merchant→category pairs. Anything not listed: propose
   the mapping, get an explicit OK, then append the pair to the profile file.
8. Tag every row's description with the statement identifier, using **the exact string shape the
   profile records** (`<issuer> invoice DD.MM.YY` in his case). Matching what his already-imported
   rows say is what makes the duplicate guard work — a differently-worded tag finds nothing.
9. Batch-write via the raw MCP endpoint (handshake in `references/price-history-web.md`) —
   `save_cash_flow_entry` is not idempotent, so a re-run must be guarded by step 8, not retried
   blind.
10. Read back: entry count and total per category must match the statement. Report both.
