# Stock short controls across 2022 — November 14, 2026

All four quarterly screens reject promotion. Across three short controls, three chronological partitions and two
execution-cost scenarios per quarter, all 52 complete paths lost money; 20 other paths remain incomplete. These
are correlated scenarios, not 72 independent observations. This extends the [initial short investigation](stock-short-research-2026-11-13.md)
without establishing a native JeV short strategy or authorizing orders.

## Design and source quality

The private registration freezes all four consecutive 2022 quarters, the existing sixteen controls and their
parameters before this acquisition. Each quarter uses its first twenty evaluation sessions for development, the
next twenty for validation and every remaining quarter session as the later partition. Each partition starts at
$100,000; results are not a continuous annual portfolio and must not be added into an annual return. There are
251 distinct evaluation sessions. Acquisition includes overlapping prior-month warmup history.

The six-symbol contemporary universe remains AAPL, AMZN, IWM, NVDA, QQQ and benchmark-only SPY. The controls and
10/20 bp adverse execution scenarios are unchanged. Fees are valued at the explicit November 13, 2026 scenario
date, rather than reconstructed 2022 tariffs. Historical borrow availability, Rule 201 restrictions, partial fills,
quote/depth evidence, margin/recalls, original arrival timing and operating charges remain unknown. Ten basis
points per side is an assumption, not an empirically calibrated historical spread. These results do not identify
break-even execution costs or test every possible short hypothesis.

This historical screen uses a subset of the native sixteen-symbol equity universe. A separate read-only sandbox
probe at 00:33:05 UTC on November 14 found all sixteen native symbols active, tradable, marginable, shortable and
easy-to-borrow, with reported 30% maintenance requirements. The account identity matched, shorting was enabled,
and account/trading blocks were clear. These are current observations, not historical eligibility or new capital
authority. No order or paid locate was submitted. A matched latest-quote probe returned IEX HTTP 200 and SIP
HTTP 403 with the provider message “subscription does not permit querying recent SIP data.” Historical SIP access
therefore cannot justify switching the live feed; live SIP stream access was not tested or purchased.

2022 is a retrospectively chosen bear year. The June dates overlap previously inspected research. Registration
before this new acquisition does not make these periods untouched prospective tests. All sixteen long and short
policies, costs, partial paths and rejections are retained. The complete report has 384 paths, of which 329 finish;
18,443 retained simulated trades were independently checked. Neither count is an effective statistical sample size.

| Quarter | Acquisition including warmup | Evaluation sessions | Raw SIP source rows | Missing regular symbol-minutes in acquisition | SPY raw price change in evaluation |
| ------- | ---------------------------- | ------------------: | ------------------: | --------------------------------------------: | ---------------------------------: |
| Q1      | Dec 1, 2021–Mar 31, 2022     |                  62 |             383,082 |                                           171 |                             -5.18% |
| Q2      | Mar 1–Jun 30, 2022           |                  62 |             390,423 |                                            79 |                            -16.77% |
| Q3      | Jun 1–Sep 30, 2022           |                  64 |             400,911 |                                             1 |                             -5.14% |
| Q4      | Sep 1–Dec 31, 2022           |                  63 |             398,086 |                                             0 |                             +5.92% |

The 1,572,502 source rows and missing-minute counts include overlapping warmups. They are not distinct annual
observations. SPY is first regular-session open to last regular-session close, on raw prices without dividends;
it is market context, not a total-return benchmark or a causal explanation of a control's outcome. Each corpus
retains a separate independently fetched calendar inventory and its full actual request/response token chain.
Missing held-position prices invalidate the entire path. AMZN gaps invalidate several Q1/Q2 scenarios; they are
not repaired by interpolation, removing AMZN after inspection or dropping losing/incomplete periods.

## Later partition results

Values below are execution-scenario USD P&L under base / stress costs. Unknown means the required complete path
was not established. The CLI's generic signal codes retain their direction; `SHORT:RELATIVE_MOMENTUM` denotes
relative weakness, `SHORT:OPENING_RANGE_BREAKOUT` a downside breakdown and `SHORT:VWAP_PULLBACK` a rejection.

| Quarter | Short control           | Later base | Later stress |
| ------- | ----------------------- | ---------: | -----------: |
| Q1      | Relative weakness       |    Unknown |   -14,671.82 |
| Q1      | Opening-range breakdown |  -3,185.48 |    -5,577.69 |
| Q1      | VWAP rejection          |    Unknown |      Unknown |
| Q2      | Relative weakness       |  -7,859.48 |   -16,523.02 |
| Q2      | Opening-range breakdown |  -3,155.60 |    -5,744.08 |
| Q2      | VWAP rejection          |  -2,841.96 |    -6,120.86 |
| Q3      | Relative weakness       |  -7,982.22 |   -15,969.57 |
| Q3      | Opening-range breakdown |  -3,680.16 |    -8,714.29 |
| Q3      | VWAP rejection          |  -3,261.31 |    -6,127.52 |
| Q4      | Relative weakness       |  -6,605.62 |   -15,899.25 |
| Q4      | Opening-range breakdown |  -2,615.10 |    -5,284.96 |
| Q4      | VWAP rejection          |  -4,093.27 |    -8,194.69 |

No short control has a positive complete development partition. Q1/Q2 select no policy; Q3 selects the 60-minute
volatility-sized long opening-range control and Q4 its fixed-risk long counterpart. Both fail the complete later
promotion rule. Development-selected identities are retained and never revised using later outcomes. The results
support rejecting these fixed numerical short controls under the stated costs, including in a falling market.
They do not establish that native chart judgments for resistance rejection or failed retests cannot work.

## Financial and source audit

An independent Python calculation checks each retained trade's direction, share quantity, entry/exit times, gross
P&L, fees and execution net P&L. Short witnesses separately verify negative opening inventory, exact cover quantity,
zero residual basis, realized cover P&L, and cash changes equal to net P&L. These witnesses remain synthetic and
unposted. Every completed path agrees with both trade and session totals. Incomplete paths retain null full-period
P&L. Source bytes and input bytes match their independently recorded SHA-256 identities. All-in profit remains null
and qualification false in every report. Native accounting and ledger tests are documented in the initial study.

| Quarter | Development  | Validation    | Later partition |
| ------- | ------------ | ------------- | --------------- |
| Q1      | Jan 3–Jan 31 | Feb 1–Mar 1   | Mar 2–Mar 31    |
| Q2      | Apr 1–Apr 29 | May 2–May 27  | May 31–Jun 30   |
| Q3      | Jul 1–Jul 29 | Aug 1–Aug 26  | Aug 29–Sep 30   |
| Q4      | Oct 3–Oct 28 | Oct 31–Nov 28 | Nov 29–Dec 30   |

| Quarter | Source SHA-256                                                     | Input SHA-256                                                      | Canonical report SHA-256                                           |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Q1      | `8690ab7795898cd6b2a6063ff853e28f4a7660e1b5f7c1b2ff7bbe70f8001e1b` | `8f846c60849a90c656c9a8a101ea4b5deb34cfbce8426e188a7370983caee1b0` | `935c210d94924e7e7e6f6c77581860ac02aed1b77c7872c5441262711b63937a` |
| Q2      | `27eeb020943715df1eccb436cf5bfd8948138ca6a5795ead467056a3c7a5cfa2` | `c1bb89a8b4368419a02ec771c668bc26086fa5ea2e7e8a87a78b11628513be1b` | `a758f2303fcdae36fad12f5f515eaefeac086080942e044b137d97d5508e150f` |
| Q3      | `15a9d0b50a74331fbbca7f8a4f981cc181dc2b30a137e68171730bd57653777a` | `bd05d11073534417b305c40a6588ec48f5643ce5d00495ae60ddaf6aa03bbe10` | `033b6d01dbc86ebff4699f2add4ac0587e7bf3087d86953b36298a24a295b0d6` |
| Q4      | `b08a4e331a571a7fdd7a6a0934e03c2acb0ceea868f7a33e65250d2378cb7ae5` | `006f3f2897eb4b6778dca6a853b77dfb19021129f01803d5edfadb0e32bec9ab` | `94642ac6ed58ca59154a1fe776a542b18909f912b36962a25d5c387c6bfa75ba` |

Use the released `bayn-equity-edge-screen` command with these pinned inputs, source streams and a new private
output. Raw bars, request envelopes, registrations, independent audit code and complete reports remain outside
Git and CI artifacts. Canonical report hashes exclude the CLI's final newline. Strategy development and opening
eligibility still require the separately versioned short-specific JeV and execution contracts described in the
initial study; this research does not promote failed controls or grant capital authority.

The private archive `bayn-stock-short-2022-evidence.tar.xz` contains all four corpora and the acquisition, input and
independent-audit code. Its 27,027,772 bytes have SHA-256
`b70a994d6a200f243640ee2327cfede1b8ebad63ef42ef210df5f71dc5c9a022`.

## Released executable reproduction

At 00:45–00:46 UTC on November 14, the deployed `bayn-equity-edge-screen` wrapper reproduced every canonical
hash above and all six initial IEX/SIP reports. The research image is
`sha256:6b18d15c3d3101770690a6d0c997918c0f8fb552ef4c1cc07991fe72d134c90f`, from reviewed main
`f0710f9ff4a59db53d283908117b141b72d9c77d`, publication run `43533283146`. Its installed screen bundle has
SHA-256 `8a66a05071494c8e9ed6cc9b8781afdcd7720ca43dd6d1596c482023494080ff`.
This exercises the shipped artifact, wrapper and filesystem boundary. It submits no orders and supplies no native
short judgments or live qualification. The normal Kargo promotion succeeded at generated revision
`d46c6bbefca3578e09819f773d7312e64bc37f63`; Argo reconciled that exact revision.
