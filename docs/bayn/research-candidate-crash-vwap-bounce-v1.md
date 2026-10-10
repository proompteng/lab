# Research candidate: crash-below-VWAP bounce (v1)

Status: `RESEARCH_ONLY`. Live strategy remains `jev`; nothing here changes fills, GitOps or the Bayn image.

## Signal

Implemented by `services/bayn/src/intraday-replay/crash-vwap-bounce.ts` (model `crash-vwap-bounce-1.0.0`). Minutes
are America/New_York minute-of-day.

| Parameter              | Value                                                       |
| ---------------------- | ----------------------------------------------------------- |
| `crashBp`              | one-minute close-to-close return ≤ −80 bp                   |
| `vwapDistBp`           | close ≤ −60 bp from cumulative session VWAP (typical price) |
| `minSessionAgeMinutes` | signal ≥ 30 minutes after 09:30                             |
| `bounceMinutes`        | close one minute later must be above the signal close       |
| `lastSignalMinute`     | 15:50                                                       |
| `lastEntryMinute`      | 15:53                                                       |

Both the crash and the bounce require consecutive minutes; a gap drops the opportunity. Entry is the bounce bar close.

Exit rules used in the exploratory search (90-minute hold, hard −50 bp stop, flatten 15:55, ≤20% equity) are not
implemented here. The shadow record lists entries only.

## Prior evidence

An exploratory grid over 191 Alpaca IEX sessions (2026-01-02 to 2026-10-06, 10 bp round trip) ranked this cell best
among hard −50 bp stop variants. The screener and corpus are not in the repository, so those results are not
reproducible from committed code and are not promotion evidence. They were also concentrated in a few semiconductor
names. Treat the definition as pre-registered for a prospective test, not as a measured edge.

## Shadow command

```sh
bun run build
BAYN_HYBRID_CRASH_VWAP=shadow node dist/hybrid-crash-vwap-shadow-command.js \
  --input session-bars.json --input-sha256 <sha256> --output shadow-record.json
```

`BAYN_HYBRID_CRASH_VWAP` accepts `off` (default) or `shadow`; any other value fails startup. With `off` the command
writes nothing. With `shadow` it decodes `bayn.hybrid-crash-vwap.session-bars.v1`, writes a new
`bayn.hybrid-crash-vwap.shadow.v1` record (never overwrites) and logs its canonical hash. `evaluatedAt` comes from
`Clock`, so a replay under a fixed clock reproduces the record hash.

## Before any promotion

1. Run unchanged on at least 20 sessions after 2026-10-06.
2. Implement the exit rules and costs in committed replay code and compare against a paired control.
3. Decide in the protocol whether symbol concentration is acceptable.
