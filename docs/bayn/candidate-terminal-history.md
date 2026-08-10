# Bayn candidate terminal history

Historical development candidates are immutable terminal records, not executable inputs to the Bayn service. The
repository retains only the compact receipt identity needed to prevent accidental reuse.

| Ordinal | Terminal status | Development metrics observed | Qualification attempts | Terminal receipt hash |
| ---: | --- | :---: | ---: | --- |
| 17 | `DEVELOPMENT_REJECTED` | yes | 0 | `52b08ccd363e18fe0c79fc51d35b17ff8b6f9007ba3dc8ae51c60c29ee921603` |
| 18 | `DEVELOPMENT_REJECTED` | no | 0 | `23370ab89857195e7a7755c3960650a0de9179e7725d10ca86e7f37906afe916` |
| 19 | `DEVELOPMENT_REJECTED` | yes | 0 | `73b39a7c70b6cdba7d030e1405d6d4151829177087a56868464f730fc9dbcdcc` |
| 20 | `PRECOMMIT_INVALID` / `UNATTEMPTED` | no | 0 | `d16c1dcbb3332cd5d490b110e9e8527525c79c05684f67cf2647df2492e2a0cd` |

Candidate 20 consumed zero metric-bearing development attempts and zero qualification attempts. Its generated source
and preregistration payloads were invalidated and removed rather than retained as reachable source.
