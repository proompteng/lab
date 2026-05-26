# Synthesis Company Profile Prefill

Synthesis stores first-class company profiles keyed by normalized public ticker symbols. Curated/xcurate items can pass an optional `companySymbols` array to `synthesis_submit_item` / `synthesis_submit_batch`; the server also derives known ticker and cashtag mentions from item titles, synthesis text, takeaways, tags, fact checks, and source-post text.

When a company symbol is associated with an item, Synthesis attempts to prefill the app-owned profile and links ticker mentions to `/companies/{SYMBOL}` instead of making an external market-data site the primary experience.

## MCP workflow

- Use `synthesis_prefill_company` for explicit enrichment or refresh. Required input: `symbol` (for example `NVDA` or `$AMD`).
- Optional manual seed fields are accepted for official-source fallback: `companyName`, `exchange`, `category`, `sector`, `industry`, `ceo`, `employees`, `headquarters`, `address`, `establishedAt`, `incorporatedAt`, `description`, and `dataSources`.
- `synthesis_submit_item` remains strict and does not accept legacy raw-post top-level fields. If company context is important, include `companySymbols`; otherwise the server derives symbols from the synthesized item and source posts.

## Providers

- Webull profile data is the preferred business-profile source when a runtime bridge is configured with `SYNTHESIS_WEBULL_PROFILE_ENDPOINT`. The endpoint must return the payload shape supplied by `mcp__webull__.get_company_profile(symbol)` or a compatible object; Synthesis normalizes it at the provider boundary.
- Alpaca is read-only optional quote context. Configure `SYNTHESIS_ALPACA_API_KEY_ID` / `SYNTHESIS_ALPACA_API_SECRET_KEY` (or `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY`) to attach latest quote fields. It is never required for static profile prefill and Synthesis does not place orders.
- Local official-source fixtures currently cover `NVDA` and `AMD` so tests and cold-start profile pages do not depend on live provider access.

The Codex host MCP tool `mcp__webull__.get_company_profile(symbol)` is not callable from the deployed app process by itself; production Webull integration needs a small bridge endpoint or runtime adapter that exposes that tool result to Synthesis through `SYNTHESIS_WEBULL_PROFILE_ENDPOINT`.
