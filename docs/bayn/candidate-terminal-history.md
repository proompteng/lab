# Bayn candidate terminal history

Historical candidates are immutable terminal records, not executable inputs to the Bayn service. This compact ledger
preserves every consumed ordinal and the strongest identity retained by the deleted candidate tooling. Ordinals 1–25
must not be reused. A dash means the legacy ledger retained no stronger identity; it does not mean the trial was absent.

## Qualification trials

Candidates 1–16 each consumed one qualification attempt. The legacy ledger retained only ordinal and terminal status
for Candidates 1–15. Candidate 16 additionally retained its terminal source and preregistration binding.

| Ordinal | Prior trials | Terminal status                          | Qualification attempts | Terminal source revision                   | Preregistration binding                                                                            |
| ------: | -----------: | ---------------------------------------- | ---------------------: | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
|       1 |            0 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|       2 |            1 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|       3 |            2 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|       4 |            3 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|       5 |            4 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|       6 |            5 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|       7 |            6 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|       8 |            7 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|       9 |            8 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|      10 |            9 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|      11 |           10 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|      12 |           11 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|      13 |           12 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|      14 |           13 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|      15 |           14 | `QUALIFICATION_TERMINAL`                 |                      1 | —                                          | —                                                                                                  |
|      16 |           15 | `QUALIFICATION_TERMINAL` / `HOLD_REJECT` |                      1 | `60a48a2e52fbafdd67a404a33a3cb22e82a98493` | source `a0dadcd2f6346968bd9df582e4673608afc04592`; blob `f602e3c8fd1b85768404d5fbc439775cdcd2570b` |

## Development trials

| Ordinal | Prior trials | Terminal status                     | Metrics observed | Qualification attempts | Terminal receipt hash                                              |
| ------: | -----------: | ----------------------------------- | :--------------: | ---------------------: | ------------------------------------------------------------------ |
|      17 |           16 | `DEVELOPMENT_REJECTED`              |       yes        |                      0 | `52b08ccd363e18fe0c79fc51d35b17ff8b6f9007ba3dc8ae51c60c29ee921603` |
|      18 |           17 | `DEVELOPMENT_REJECTED`              |        no        |                      0 | `23370ab89857195e7a7755c3960650a0de9179e7725d10ca86e7f37906afe916` |
|      19 |           18 | `DEVELOPMENT_REJECTED`              |       yes        |                      0 | `73b39a7c70b6cdba7d030e1405d6d4151829177087a56868464f730fc9dbcdcc` |
|      20 |           19 | `PRECOMMIT_INVALID` / `UNATTEMPTED` |        no        |                      0 | `d16c1dcbb3332cd5d490b110e9e8527525c79c05684f67cf2647df2492e2a0cd` |
|      21 |           20 | `DEVELOPMENT_REJECTED`              |       yes        |                      0 | `66b3d91ecf84d85cf95b12f200b83aa21b9d1d84ea1dd94c8c70d238527cff01` |
|      22 |           21 | `DEVELOPMENT_REJECTED`              |       yes        |                      0 | `56d845e58845106a54569278eb5c265437dbe288ac93a1d97de2dc886169af24` |
|      23 |           22 | `DEVELOPMENT_REJECTED`              |       yes        |                      0 | `232a7554bbc4b46c0db4c5045900220379abeb74cb1f376ced6ae526d838f739` |
|      24 |           23 | `DEVELOPMENT_REJECTED`              |       yes        |                      0 | `79ebe94383b18aa7a896b724b3c8f29247fc23d73c32e90b780bb2e37da95d41` |
|      25 |           24 | `DEVELOPMENT_REJECTED`              |       yes        |                      0 | `c26b1ed91e9467f7dc3c2018f9a96f7b3672c291cf427ceaaf8da4a18050eaee` |

The development receipts for Candidates 21–25 bind the following immutable evidence graph:

| Ordinal | Binding hash                                                       | Evaluation hash                                                    | Target hash                                                        | Qualification-analysis hash                                        |
| ------: | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
|      21 | `13b33dcea0c9d0d59c3322fe83855c56f6bdf1abeb0365e48843f120d21d87cf` | `59523519ec4815f47970927ed38aa29785a4a8fb8ddec300748e629eea96fe12` | `b89e6f19f883c93126218de50a218a0aa8b5ca588dd55324bcd4831c191b2fea` | `4a47fa4c5a77ecf162427cba22d101f6f1b0e482c5ca222f58cc6fdeb93f3852` |
|      22 | `82326feb8cbb26a854b6ea0cb922ec5e199713562057079fdbf2bdcc3e851654` | `bd98ee2294dd48caecf682419e0b094f92cac1972be7af7aff8363a60188fa00` | `e9e46ab3cecfaa95cd88cb65a83a571edfbc05909b9940057e2bea5277f78acf` | `fdb003763930de38e74d0c3ab00d9fa6480ad35a973b8ca884fd8987750e7533` |
|      23 | `c14806eca01e02645d18a98b5ffb1668ac7839f8049f702ad0ae23fcb7e57c8f` | `c407ff956f50dac3a6dfc015d1038d7cae43314c05c14daf8759ac3b3a6a97a1` | `d31e47331c02e93ae4f36aec8958ec1b3337116c2ac9669343c139935f3c71d5` | `9bc11fc3026a938f4109c96298050a713b7ad14379c76181f12835cccda65784` |
|      24 | `87f0bde9788d426f53ccbcb777d0c46b5b75cea6cf3037d7b1e0444dcbbc8d49` | `354a9b9b7c5bbf2f9b4178c932ab47c36d22d5b78b28af6ed483333181ef5ef5` | `2ff28a5b3772d6861995de738f4800f03458e78edc6c15dfa9e00721b88763ae` | `eb73fe8520833eac7b06a138d4d496ea07a36fb4ae6140399709d047dee69d6d` |
|      25 | `dc8e691bf2cd9efbf6e64b57dc385f4fe6a69c909d84d91d29ef02da06f1a564` | `ac07f6d7f55f2fd6258e99d30b00aee679513a4e2b59afcbd5e3a37920a8c4a7` | `abdb35449efae707768c9a010cf0e62f5e9ade9572b4ec0151a982a10005596a` | `9019a1dfd764518f9b4543c2920511cb91398c45d7109f5bccaae4b18e43804c` |

Candidate 20 consumed zero metric-bearing development attempts and zero qualification attempts. Its generated source
and preregistration payloads were invalidated and removed rather than retained as reachable source.
