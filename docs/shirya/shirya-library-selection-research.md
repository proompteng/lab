# Shirya Library Selection Research (OSS-Only, High Excel Compatibility)

Status: Completed (2026-02-21)

## Requirement Baseline

- Must be truly open-source for the required runtime components.
- Must provide high compatibility with Excel formulas/behavior.
- Must be actively maintained (no stale or abandoned core dependency).

## What Changed From Prior Recommendation

`FortuneSheet` was removed from the primary recommendation.

Reason: while not fully dead, its release cadence and formula stack confidence are weaker for a high-compatibility requirement compared to currently active alternatives. For this requirement, we should optimize for compatibility guarantees first.

## Final Recommended Stack

1. UI/runtime: `jspreadsheet-ce` (MIT)
2. Formula engine: `hyperformula` (GPL-3.0-only)
3. CRDT model: `yjs` (MIT)
4. Offline provider: `y-indexeddb` (MIT)
5. Realtime provider: `y-websocket` (MIT)
6. Collaboration backend: `@hocuspocus/server` (MIT)
7. Browser persistence for non-CRDT state: `dexie` (Apache-2.0)
8. Backend event stream between sync/calc services: `nats` (Apache-2.0)

## Why This Stack

- `HyperFormula` explicitly documents Excel and Google Sheets compatibility tracks, a differences list, and a large built-in function set (~400). This is the strongest OSS formula compatibility path currently available in JS.
- `Jspreadsheet CE` gives an actively maintained OSS spreadsheet UI with Excel-like interactions (copy/paste shortcuts, formulas, keyboard navigation) and MIT licensing.
- `Yjs + Hocuspocus` remains the most mature OSS local-first collaboration path in the web ecosystem.

## Maintenance Evidence (as of 2026-02-21)

| Component             | npm latest | npm latest publish | Weekly npm downloads | Last Git commit        | License                 | Decision     |
| --------------------- | ---------- | ------------------ | -------------------: | ---------------------- | ----------------------- | ------------ |
| `jspreadsheet-ce`     | `5.0.4`    | 2025-08-25         |               43,108 | 2026-02-20             | MIT (repo license file) | Selected     |
| `hyperformula`        | `3.2.0`    | 2026-02-19         |              194,635 | 2026-02-20             | GPL-3.0-only            | Selected     |
| `yjs`                 | `13.6.29`  | 2026-01-03         |            2,391,925 | 2026-02-15             | MIT                     | Selected     |
| `y-websocket`         | `3.0.0`    | 2025-04-02         |              218,477 | 2026-02-18             | MIT                     | Selected     |
| `y-indexeddb`         | `9.0.12`   | 2023-11-02         |              187,267 | N/A (provider package) | MIT                     | Selected     |
| `@hocuspocus/server`  | `3.4.4`    | 2026-01-25         |              175,874 | 2026-02-20             | MIT                     | Selected     |
| `dexie`               | `4.3.0`    | 2025-12-20         |              989,535 | 2026-02-18             | Apache-2.0              | Selected     |
| `nats`                | `2.29.3`   | 2025-03-19         |              460,865 | 2026-02-11             | Apache-2.0              | Selected     |
| `@fortune-sheet/core` | `1.0.4`    | 2025-11-06         |               17,950 | 2025-11-06             | MIT                     | Not selected |

## Rejected / Conditional

- `FortuneSheet`: removed as primary due lower confidence for high Excel compatibility and slower activity signal versus alternatives.
- `AG Grid Community`: MIT and actively maintained, but spreadsheet-like features are split by Community vs Enterprise boundaries; not ideal as the primary OSS spreadsheet runtime for this project.
- `Univer`: OSS core exists, but mixed OSS + Pro product model does not align with strict OSS-only policy for this project.

## Build-From-Scratch Considerations

Even with the selected stack, some critical components must be built in-house.

### Must Build In-House (recommended regardless)

1. Shirya workbook model and operation protocol.
2. CRDT-to-grid binding layer (Yjs doc <-> UI updates).
3. Backend authoritative calc pipeline (op log -> calc run -> patch stream).
4. Conflict UX and reconciliation telemetry.
5. Compatibility harness against real Excel fixtures.

### Full Scratch Option (if you reject GPL formula engines)

You would need to build a full formula engine stack:

1. Parser + AST + dependency graph.
2. Function library semantics + type coercion matching Excel.
3. Volatile function behavior (`NOW`, `RAND`, etc.).
4. Error model parity (`#REF!`, `#VALUE!`, etc.).
5. Array formula and named range semantics.

This is high-risk and requires substantial engineering investment before reliable Excel-level behavior.

### Recommended Path

1. Use `hyperformula` as compatibility core now.
2. Build Shirya-specific UX/sync/calc orchestration around it.
3. Keep formula API abstracted so engine can be swapped later if licensing strategy changes.

## Sources

- HyperFormula docs: https://hyperformula.handsontable.com/
- HyperFormula compatibility pages:
  - https://hyperformula.handsontable.com/guide/compatibility-with-microsoft-excel.html
  - https://hyperformula.handsontable.com/guide/list-of-differences.html
- HyperFormula licensing page: https://hyperformula.handsontable.com/guide/licensing.html
- Jspreadsheet CE repo: https://github.com/jspreadsheet/ce
- Jspreadsheet CE npm: https://www.npmjs.com/package/jspreadsheet-ce
- AG Grid Community vs Enterprise: https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise/
- Yjs docs: https://docs.yjs.dev/
- y-websocket docs: https://docs.yjs.dev/ecosystem/connection-provider/y-websocket
- y-indexeddb docs: https://docs.yjs.dev/getting-started/allowing-offline-editing
- Hocuspocus docs: https://tiptap.dev/docs/hocuspocus/getting-started/overview
- Dexie docs: https://dexie.org/docs/Tutorial/Getting-started
- NATS.js repo: https://github.com/nats-io/nats.js

## Data Collection Method

- npm metadata: `npm view <package> version time license`
- npm download velocity: `https://api.npmjs.org/downloads/point/last-week/<package>`
- Repository recency: `git clone --depth 1` + `git log -1 --date=iso-strict`
