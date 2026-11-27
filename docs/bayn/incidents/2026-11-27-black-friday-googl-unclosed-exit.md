# Black Friday 2026: GOOGL short missed its intraday exit

**Impact:** Alpaca Paper carried an unprotected 103-share GOOGL short after the 13:00 ET regular close.
The active cycle retained account recovery ownership and other alpha sleeves could not proceed. This was not a
live-capital trade. The cycle was still `ACTIVE` at the incident readback; this change does not operate the account
or establish that the position subsequently closed.

## Evidence

All times below are UTC on 2026-11-27 (ET = UTC−05:00). The controller ran source
[`ac4a6c904b`](https://github.com/proompteng/lab/tree/ac4a6c904b35fce2647eee7dde2b81d8d888e13a).

| Time                      | Persisted or broker evidence                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15:02:09 (10:02:09 ET)    | MorningOrb cycle `facb8ea9…` sold 103 GOOGL against a $271.08 reference and $270.81 limit; average fill $271.0255. The native DAY children were a $261.81 buy limit and a $275.31/$275.58 buy stop-limit.           |
| 15:02:21–18:01:20         | `execution_controller_observations` recorded 354 same-pass broker reconciliation failures with `NO_ADMISSIBLE_CUT`, spanning the 16:28 hard exit and 17:55 pre-close deadline. The 16:28:02.386 row is one example. |
| 18:01:35                  | DAY take-profit expired and the stop-limit was canceled. The stop-limit had not filled as GOOGL reached $275.88.                                                                                                    |
| 18:01:49                  | First recovered pass after the expirations reported `POST_MUTATION_RECONCILIATION`.                                                                                                                                 |
| 18:02:03.190–20:33:54.282 | 5,548 recorded `CLOSE_MARKET_DATA_UNAVAILABLE` passes. The close archive reported “intraday snapshot lacks a post-range quote for every symbol” for GOOGL.                                                          |

The read-only join of `autonomous_cycles` and `autonomous_cycle_shadow_decisions` for
`facb8ea912ceacd21faa8c6b8756d69d44c7c25891d9c4398bca4d40e7925acf` confirmed
`execution_session_date = 2026-11-27`, cycle and v3 binding hours of 13:00–22:00Z, and an entry cutoff of 21:55Z.
The same binding's calendar retained provider regular hours of 14:30–18:00Z and the GOOGL plan retained its
60-minute maximum hold. Broker capture trace `e3bfa05d1ccf365637555fa1cd6a87a6` independently records the exception
“Open broker orders differ from the complete broker history.”

## Root cause

1. **Neither timed exit reached the protection interpreter.** The capture requested
   [`status=open&nested=true`](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/broker/alpaca/requests.ts#L52-L62).
   Nested open-order filtering can hide the working children once their bracket parent is filled. The resulting open
   set disagreed with nested complete history and the
   [capture rejected the whole cut](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/broker/alpaca/snapshot-cache.ts#L100-L110).
   The [same-pass preflight](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/observe-composition/recovery-driver.ts#L904-L921)
   prevented recovery from acting on incomplete orders. With an admissible cut, the
   [fill-relative maximum hold](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/jev/runtime.ts#L668-L678)
   was already due around 16:02:09, and the
   [independent MorningOrb 11:28 ET hard deadline](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/observe-composition/execution-cycle.ts#L841-L867)
   would force release even with open protection. The
   [native stop guard](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/observe-composition/position-protection-interpreter.ts#L235-L286)
   only suppresses a one-sided IEX **price** stop; it does not suppress a timed exit.
2. **The durable cycle used IEX capture hours, not the broker's regular hours.**
   [Admission selected `calendar.sessions`](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/cycle/runner/calendar-decisions.ts#L108-L130),
   [construction subtracted five minutes from that close](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/cycle/construction.ts#L210-L222),
   and the [v3 binding copied the cycle window](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/execution-session.ts#L165-L205).
   The alpha runtime did already shorten its in-memory flatten window to regular hours; it never reached that close
   path while reconciliation was failing. The wrong durable bounds mattered to the separate price planner.
3. **The price planner used the wrong clock for both fallback and post-session recovery.** It
   [tested the mark fallback against the durable extended close](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/observe-composition/decision-builder.ts#L1724-L1764)
   and [kept requesting IEX until that same instant](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/observe-composition/decision-builder.ts#L1866-L1875).
   At 18:02 the fallback was not yet allowed and IEX could not supply the required fresh quote. The
   [controller retained a quote retry](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/observe-composition/recovery-driver.ts#L655-L666)
   and [did not throttle market wakes for that reason](https://github.com/proompteng/lab/blob/ac4a6c904b35fce2647eee7dde2b81d8d888e13a/services/bayn/src/execution/controller.ts#L356-L373).

## Correction and verification

- List open Alpaca orders flat while retaining nested complete history. The two views still have to agree on every
  live order after restoring child lineage from history. Missing/conflicting orders still fail closed.
- Bind new equity cycles to provider regular hours; leave the IEX envelope and immutable historical bindings intact.
  On both fresh and legacy cycles, use the same regular-session schedule to release native protection and authorize
  position-mark fallback. A close-only lease can expire before a legacy extended entry cutoff.
- If IEX is unavailable after a mandatory exit becomes due, recheck exact broker state and use its current position
  mark under the existing adverse-price collar and signed quantity bounds. After the regular close, skip IEX and use
  this path only within the verified, bounded broker recovery lease. If no lease remains, report
  `CLOSE_WINDOW_EXPIRED` without market-driven retry; the cycle still owns reconciliation and recovery.
- Regression coverage: `broker/alpaca/snapshot-cache.test.ts` reproduces the filled GOOGL bracket and missing open
  children; `execution-session.test.ts` covers both November 27 and December 24 cutoffs;
  `observe-composition/closing-market-data.test.ts` exercises native release at the overdue 11:28/12:55 passes and a
  collared buy of exactly 103 shares with a stale quote, including the 18:02:03 post-close recovery.
- The active `bayn.intraday-alpha-policy.v2` canonical hash remains
  `f632170473534577a59a98c800bca69917b710c3857a68d0c52ec776ebcdd509`. Migrations 0222 and 0223 are unchanged.
