# Research candidate: crash-below-VWAP bounce

Status: `RESEARCH_ONLY`. Live strategy remains `jev`; nothing here changes fills, GitOps or the Bayn image.

## Signal

Implemented by
[`intraday-replay/crash-vwap-bounce.ts`](../../services/bayn/src/intraday-replay/crash-vwap-bounce.ts) (model
`crash-vwap-bounce-2.0.0`). Minutes are America/New_York minute-of-day.

| Parameter                          | Value                                                        |
| ---------------------------------- | ------------------------------------------------------------ |
| `crashBp`                          | one-minute close-to-close return ≤ −80 bp                    |
| `vwapDistBp`                       | close ≤ −60 bp from cumulative RTH session VWAP              |
| `minSessionAgeMinutes`             | signal at least 30 minutes after 09:30                       |
| `bounceMinutes`                    | close one minute later is above the signal close             |
| entry                              | open of the bar after confirmation (proxy, not a quote)      |
| `flattenMinute`                    | 15:55, or `flattenBeforeCloseMinutes` (5) before early close |
| `signalCutoffBeforeFlattenMinutes` | no signals in the last 5 minutes before flatten              |

The history must be contiguous from 09:30 with positive volume on the four bars used. The scan stops at the first
gap rather than inventing bars. Exits (hold, stop) are not implemented; the record lists entries only.

## Prior search

An exploratory parameter search on 191 Alpaca IEX sessions (2026-01-02 to 2026-10-06) selected this cell. Its
generator and corpus were never committed, both halves of the sample influenced selection, and its results were
concentrated in a few semiconductor names. It is not evidence of an edge and its numbers are not reported here. The
90-minute hold it used also exceeds the 15-minute maximum hold in the native Jev protocol.

## Shadow command

```sh
bun run build
BAYN_HYBRID_CRASH_VWAP=shadow node dist/hybrid-crash-vwap-shadow-command.js \
  --input session-bars.json --input-sha256 <sha256> --output shadow-record.json
```

`BAYN_HYBRID_CRASH_VWAP` is `off` (default) or `shadow`; any other value fails startup. `off` writes nothing.

Input `bayn.hybrid-crash-vwap.session-bars.v2` declares the `alpaca`/`iex` source, dataset and calendar identity, a
13:00 or 16:00 close, a unique universe and a completed-through minute. Decoding rejects symbols outside the universe,
bars past the watermark or outside RTH, and timestamps that are not the UTC start of the bar's New York minute.

Output `bayn.hybrid-crash-vwap.shadow.v3` holds the source declaration, candidates, input hash and an
`INCOMPLETE_RTH_MINUTE_COVERAGE` exclusion for each universe symbol missing minutes through the watermark. The command
never overwrites output, and `evaluatedAt` comes from `Clock`, so a fixed-clock replay reproduces the record hash.

## Before any promotion

1. Commit a reproducible replay with exits and costs, and compare against a paired control.
2. Run unchanged on at least 20 sessions after 2026-10-06.
3. Meet the acceptance-v2 requirements, including concentration and execution stress, and resolve the hold limit.
