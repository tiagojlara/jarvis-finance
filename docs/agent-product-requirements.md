# Product requirements: Tamanduá Finance Assistant

**Status:** Draft  
**Date:** 8 November 2026  
**Product:** Tamanduá Finance, local-first personal finance tracker

## 1. Summary

Add an in-app conversational assistant that can answer questions about the user's Tamanduá Finance data and connect to configured MCP servers. Phase one focuses on chat and useful, locally cached AI summaries. Phase two adds document uploads, extraction, and reviewed ledger updates.

The assistant is an organizing and data-entry tool, not a financial adviser or transaction executor. Any finance write must follow existing tool safeguards and require user review and confirmation.

## 2. Product context

Tamanduá Finance is a local-first React application with an Express API and SQLite database. It already serves an MCP endpoint at `/mcp`. The current MCP server exposes portfolio and cash-flow read tools and selected writes, including `save_price`, `save_fx_rate`, dividend operations, and cash-flow operations. It does not currently expose an upload or import workflow, and the web application does not host a chat or act as an MCP client.

The application tracks investments, cash balances, dividends, net worth inputs, and a separate income-and-spending ledger. Financial values retain their original currencies. Asset prices are dated snapshots, not live quotes. Statement imports must respect these distinctions and existing validation rules.

## 3. Goals

1. Let a user ask natural-language questions about their Tamanduá data and receive answers grounded in retrieved records.
2. Provide useful AI summaries in relevant finance views, cached locally and refreshable on demand.
3. Reuse the same validation and data semantics as the existing UI and API.
4. Connect to explicitly configured MCP servers, with clear visibility into which tools are available and what data each tool may access.
5. Keep the product local-first by default and make model/provider data sharing understandable and configurable.
6. Surface concise AI summaries in relevant finance views, always with date ranges, currency scope, and links to supporting data.

## 4. Non-goals

- Investment recommendations, tax advice, credit advice, or guarantees about future outcomes.
- Placing trades, initiating payments, or changing account credentials.
- Silent imports or autonomous modification of financial records.
- Bank login scraping or automatic bank synchronization in the MVP.
- Real-time prices or claims that a document's extracted price is a current quote.
- Replacing the existing ledger, portfolio calculations, or backup and restore model.
- Connecting to arbitrary remote MCP servers without user configuration and a trust decision.

## 5. Users and primary jobs

- **Personal finance tracker:** “What changed in my spending last month?”
- **Statement importer (phase two):** “Read this card statement, categorize the transactions, and show me what would be added.”
- **Portfolio maintainer:** “Extract the fund prices from this valuation report and update the dated prices after I review them.”
- **Data-aware assistant user:** “Summarize my holdings and explain which prices or FX rates are stale or missing.”

## 6. Core experience

### 6.1 Chat

- Add an Assistant entry point in the application navigation and a responsive chat view.
- Support text questions, conversation history, and a clear “new conversation” action. File attachments are out of scope for phase one.
- Persist chat history locally in the application's database, with controls to inspect and delete conversations.
- Ground answers in Tamanduá data retrieved through narrowly scoped tools; show which records, date range, and currencies support each answer.
- Clearly label generated interpretation versus values read directly from the database.
- If required data is unavailable, stale, incomplete, or ambiguous, say so and offer the next useful action.
- Phase one chat is read-only with respect to Tamanduá financial records. Phase two may add reviewed imports and writes; it must distinguish proposing an action from completing it, and stage all changes for review before execution.

### 6.2 MCP connections

- Provide a settings view to add, inspect, enable, disable, and remove MCP server connections.
- For the built-in Tamanduá server, connect to the local `/mcp` endpoint and use the existing tool contracts.
- For external servers, support configured MCP transports through a documented adapter; show server identity, transport, available tools, and granted capabilities before enabling.
- Begin with read-only capabilities for external servers. Require a separate, explicit per-server write grant before offering write tools.
- Do not infer that a connected MCP server is trusted to access every tool. Allow users to disable individual tools or capability groups.
- Show tool activity in the conversation, including server, tool name, and a readable summary of inputs and results. Redact secrets from logs and UI.
- Connection secrets must be stored using an appropriate local secret store or encrypted configuration, not in ordinary chat history or the SQLite finance tables.

### 6.2.1 Model connection settings

- Support any model endpoint compatible with the OpenAI API protocol; do not require a specific model vendor.
- Provide Settings fields for API base URL, API token, and model identifier. Add optional compatible API path/version settings only if required by supported endpoints.
- Persist these settings in the application's SQLite database so they survive restarts and are part of the local configuration. Keep the token in a dedicated settings record, never in conversation messages, tool arguments, logs, backups intended for sharing, or client-visible API responses.
- Encrypt the token at rest in the database using an application encryption key held outside the database, preferably in the operating system's credential store. If that store is unavailable, require a documented local key-provisioning method; never store the key beside the ciphertext.
- Display the configured base URL and model identifier in Settings, keep the token masked, and allow it to be replaced or cleared without revealing its saved value.
- Provide a “Test connection” action using a minimal request with no financial data; show success or a sanitized error.
- Send prompts, retrieved finance data, and uploaded document content to the configured endpoint only when needed for the requested assistant action. Explain this data flow before first use and in Settings.
- Validate endpoint URLs and block insecure remote HTTP endpoints by default; allow localhost HTTP for local inference. Proxy model requests through the local server so the token never reaches browser code.

### 6.3 Upload and import (phase two)

- Accept user-selected documents in chat. Initial phase-two formats: PDF and CSV; enforce configurable file size and page/row limits.
- Keep uploads local during parsing where possible. If a remote model or OCR provider receives document content, disclose that before the first upload and provide a local-only mode when supported.
- Show upload filename, detected format, parsing status, and an option to remove the document and its extracted preview.
- Parse to a structured draft, never directly to ledger writes. Retain a link from each proposed row to its source page, row, or text excerpt when available.
- Let users correct date, amount, currency, account, payee/description, category, and asset mapping before import.
- Validate all fields against existing business rules. Surface duplicate candidates and conflicts; do not silently skip or overwrite.
- Provide a review screen with counts and totals by currency, followed by a single explicit “Import selected” action. Report precisely which records were created, skipped, or rejected.
- Keep an import receipt with source filename, import time, parser/model version, decisions, and created record IDs. The user can remove the uploaded source separately from the resulting finance records.

#### Credit-card statement flow (phase two)

1. User attaches a statement and chooses the card account, or confirms the detected account.
2. Assistant extracts transaction date, posting date if present, description, amount, currency, and any available statement reference.
3. Assistant suggests income/expense direction and cash-flow category using existing categories and user-approved mappings.
4. User reviews rows, filters or edits them, resolves duplicates, and selects rows to import.
5. Import creates cash-flow entries using the selected account's currency and existing cash-flow validation. It does not create investment transactions or change holdings/net worth.

#### Price update flow (phase two)

1. User uploads a statement/report or asks the assistant to extract prices from a provided source.
2. Assistant identifies candidate assets, price values, currencies, and effective dates; it must not guess a match where multiple assets fit.
3. User confirms asset mapping and date for each proposed price.
4. Assistant previews existing prices on those dates and explains that applying an update follows current `save_price` behavior: it replaces a Manual row for the same asset/date and does not overwrite provider-sourced rows.
5. User approves selected prices. The result is recorded as dated Manual snapshots, not live quotes.

## 7. AI summary placements

Summaries can be generated on demand or refreshed by the user, then cached locally for reuse. Show the generation/refresh timestamp, data as-of date, period, currency treatment, and supporting records. Make refresh available wherever a summary appears. When relevant source data changes, mark the cached summary stale and offer refresh. Avoid duplicating a figure without stating its scope.

| Placement | Summary value | Required context |
|---|---|---|
| **Overview** | Short portfolio and cash snapshot, notable changes since the prior comparable period, and data gaps | Valuation date; totals by currency; prices/FX dates; no implied investment recommendation |
| **Cash flow** | Income, spending, net cash flow, largest categories, and unusual changes for the selected period | Exact period; per-currency breakdown; compare equal-length periods only |
| **Portfolio / asset detail** | Holding movement, cost basis and unrealized gain/loss context, plus missing or old price observations | Asset and account scope; source/date of prices; no forecasts or buy/sell advice |
| **Net worth** | Change in recorded assets and liabilities, with stale valuation/balance callouts | Snapshot dates and currencies; explicitly label manual estimates |
| **Statement review (phase two)** | Plain-language description of detected rows, totals, uncertain fields, and duplicates | Uploaded file and page/row references; label all values as extracted pending review |
| **Price review (phase two)** | Summary of proposed asset/date/price changes and conflicts with existing rows | Source references; dated snapshot semantics; Manual/provider behavior |
| **Retirement projection** | Explain the displayed scenario and which assumptions drive it | Assumptions, nominal values, exclusions already documented by the product; no guarantee |

Summary content must not hide the underlying tables or charts, and must not be used as the sole confirmation surface for a financial write.

## 8. Requirements

### Functional requirements

- **FR-1 Grounded answers:** The assistant retrieves relevant records using Tamanduá API/MCP tools rather than relying on model memory. It reports when evidence is incomplete.
- **FR-2 Currency integrity:** Never add or compare unlike currencies as one total unless an explicit conversion and rate date are shown. Default summaries retain per-currency totals.
- **FR-3 Read/write separation:** Read tools may run to answer a question. Any operation that creates, updates, or deletes finance data must be previewed and separately confirmed by the user.
- **FR-4 Import review (phase two):** Every file import produces a structured, editable draft and a result receipt. No direct document-to-database writes.
- **FR-5 Idempotency and duplicates (phase two):** Re-import detection uses stable source identifiers where present plus normalized account/date/amount/description matching; uncertain matches are presented to the user.
- **FR-6 Validation:** Reuse existing API/domain validation for accounts, currencies, categories, date formats, positive prices, and ledger semantics.
- **FR-7 Provenance (phase two):** Every imported row retains source-document provenance and any extraction confidence/uncertainty needed for review.
- **FR-8 Tool transparency:** Users can see which tools ran and whether they read or wrote data.
- **FR-9 Failure handling:** Tool errors produce actionable messages. Phase two adds partial parsing/import outcomes and retry safety so successfully imported rows are not duplicated.
- **FR-10 History controls:** Users can inspect and delete locally persisted conversation history. Phase two adds upload deletion controls; deleting a conversation or source file does not silently delete committed financial records.
- **FR-11 Accessibility and responsive layout:** Chat, attachment review, summaries, and confirmations work on narrow screens and with keyboard/screen-reader navigation.

### Phase-one traceability

- **FR-8:** CopilotKit tool chips show live reads and restored tool activity; summary runs use a separate non-numeric runtime thread and do not create chat history rows.
- **FR-10:** Conversations and messages remain in the dedicated assistant tables; summaries are cached separately and are not transcript entries.
- **FR-11:** The launcher clears the 61px mobile navigation bar, the chat panel is viewport-bounded, and the disclosure dialog receives keyboard focus. Browser verification is still required for release.

The measured production bundle is 258.05 kB gzip for the lazy CopilotKit chat/runtime chunk and 95.71 kB gzip for the app entry. CopilotKit telemetry is disabled by default with `COPILOTKIT_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1`.

### Quality requirements

- Keep the current local-only deployment behavior as the default. Do not bind the server to a public interface as a side effect of adding chat.
- Use explicit connection settings and minimal capabilities. Treat document contents and MCP tool output as untrusted data, not instructions.
- Keep model credentials out of client bundles, logs, conversation history, and finance records. The dedicated encrypted settings record is the only database location for the token.
- Clearly distinguish model-generated language from database values. Phase two also distinguishes extracted source text.
- Phase two must maintain usable performance for typical statements, show progress for longer documents, and allow cancellation.
- Phase two must provide a recoverable audit trail for committed imports and report before/after values when updating an existing Manual price.

## 9. Safety, privacy, and trust

- Financial records and uploaded statements are sensitive. Explain that prompts, retrieved records, and attached document content may be sent to the configured OpenAI-compatible endpoint before the first request that uses them.
- Keep conversation history on the local machine. Phase two keeps uploaded files local as well. When using a remote model endpoint, disclose that content sent for a request leaves the machine; local persistence does not imply local inference.
- Apply file type/size limits, safe temporary storage, and cleanup on cancellation or expiry. Do not execute or render active document content.
- Protect the MCP endpoint with an explicit trust boundary before exposing it beyond localhost. Any future remote access requires authentication, authorization, and transport security.
- Treat instructions embedded in uploaded documents and MCP responses as untrusted content. They cannot authorize tools, change policy, or bypass user confirmation.
- Require confirmation when a write would replace an existing record or when a duplicate/correction is ambiguous. Show the exact affected rows and resulting values.
- Do not let model-generated summaries change records or assumptions.

## 10. MVP scope and rollout

### Phase one: chat and summaries

1. Settings for an OpenAI-compatible model endpoint (base URL, token, model identifier), with encrypted local persistence and a test-connection action.
2. In-app chat with Tamanduá read tools and source-backed answers.
3. Local Tamanduá MCP connection managed by the app.
4. Locally persisted chat history and deletion controls.
5. AI summaries for Overview and Cash flow, generated on demand and cached locally with a visible refresh timestamp and stale-data indication.
6. Read-only use of existing Tamanduá MCP tools in chat.

Phase one does not include document uploads, data imports, or writes to Tamanduá financial records through the assistant.

### Phase two: document upload and import

- PDF/CSV credit-card statement extraction into a draft and review/import flow for cash-flow entries.
- Price extraction from uploaded files into a dated-price review flow.
- Explicit write confirmation, duplicate handling, provenance, and import receipts for document-driven writes.
- Statement review and Price review summaries.
- All import workflows, including future import formats or sources, belong to phase two or later.

### Later follow-up

- User-configured external MCP servers, beginning read-only and expanding through explicit per-tool grants.
- More broker/bank export formats, richer recurring import profiles, and local OCR/model adapters.
- Additional summaries for asset detail, Net worth, and Retirement projection.

## 11. Success measures

- Users can answer common portfolio/cash-flow questions with source records and clear currency/date context.
- Chat answers common portfolio/cash-flow questions with source records and clear currency/date context.
- Cached summaries show their freshness and can be refreshed on demand.
- Phase one chat does not write to Tamanduá financial records. Any phase-two finance write follows a visible preview and explicit confirmation.
- Phase two success includes reliable statement review, duplicate resolution, and price updates that never silently overwrite provider-sourced records.
- Users can determine what data leaves the machine and remove chat history; phase two adds upload deletion controls.

## 12. Open decisions

- Which OS credential-store integrations should be supported first for the database encryption key, and what fallback key-provisioning method should be offered?
- What transport/authentication methods are in scope for external MCP servers?

## 13. Dependencies and implementation notes

- Extend current server and client without changing the meaning of existing ledgers or calculations.
- Phase one adds local conversation and cached-summary persistence. Finance records remain authoritative in current tables.
- Phase two adds a domain-level import service that validates drafts and commits using the same rules as cash-flow and price writes. Avoid a second, weaker write path.
- Phase two adds upload metadata, drafts, and import receipts with explicit retention and deletion behavior.
- Keep model-provider and MCP-client adapters separate from UI components so deployments can choose local or remote providers.
- Preserve the current MCP server's descriptions and safety semantics; the app acting as an MCP client is a separate capability from exposing `/mcp` to external agents.
