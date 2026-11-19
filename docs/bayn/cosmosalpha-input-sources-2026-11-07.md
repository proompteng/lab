# CosmosAlpha reference inputs and model access

Research cut: November 7, 2026, America/Los_Angeles. Use the authors' linked data bundle and the existing self-hosted Flamingo model. No paid model subscription is required for the selected replication arm. A reconstruction from other data vendors is unnecessary unless the original bundle fails admission.

## Get the original data

The [pinned author README](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/README.md#data) links [Zenodo record 23857833](https://zenodo.org/records/23857833). Download its `data.zip` through the record’s public file link. The record is titled “A-shares Daily Equity Dataset for CosmosAlpha Reproducibility”, published November 1, 2026, and lists CC BY 4.0. The file is 536,128,200 bytes with publisher checksum `md5:2453b7658b82a7ac208c4a739350c437`.

The README says to use three providers:

| Provider | Required fields |
|---|---|
| `qlib_bin` | open, high, low, close, volume, vwap, turn, free_turn, returns |
| `qlib_exposure_bin` | industry_id, log_mkt_cap and the industry manifest |
| `qlib_mask_bin` | universe_mask, eligible_mask, entry_tradable_mask, exit_tradable_mask |

Each provider needs matching calendar and CSI300 universe data. Validate the complete file against the publisher checksum, record a separate SHA-256, inspect archive paths, verify field/calendar/universe alignment and read the industry/mask metadata before running. Keep the frozen April 2010–May 2019 reference window and January 2010 warmup, the 100-stock minimum cross-section and the 80% admission thresholds. Download completion alone does not pass those checks.

The authors [explicitly disclose missing strict point-in-time certification for industry data](https://github.com/wzhmtldswz/CosmosAlpha/blob/237f0a56895fd295542e202be8f62be48d6e9995/docs/configuration.md). Preserve that limitation. Original historical data identity is not evidence of original broker-worker arrival times or a prospective Bayn evaluation.

## Use the existing model

The selected run uses [Flamingo](../../argocd/applications/flamingo/README.md), served as `qwen38-flamingo` at `http://flamingo.ide-newton.ts.net/v1`. Live readback confirmed `nvidia/Qwen3.8-27B-NVFP4`, checkpoint and tokenizer revision `482ca0f3832238542f8f5295dde86b5f22711d80`, with serving image digest `sha256:7ef5a35d1ef8ce2cf9d671dd91eec6e367c5849262e0362b4d3d4a26be0d87d2` and 262,144-token context.

The model-list and JSON completion requests succeeded without an Authorization header. The JSON probe used 23 input and six output tokens. The upstream config requires a nonempty key field even for anonymous servers; the local adapter uses a clearly identified non-secret compatibility marker and strips Authorization before sending. It creates no credential or account.

This is a declared Qwen backbone replication of the pinned Graph and Chain methods. It does not reproduce the paper's DeepSeek model results. Keep raw returned model IDs, sampling settings, serving identity and all request/usage receipts. External API fees are zero for this route; local GPU, CPU and research costs still need allocation before an economic claim.

## Published DeepSeek setup

The pinned configuration uses the OpenAI-compatible Chat Completions/JSON route at `https://api.deepseek.com`, with `model_alias = "deepseek-flash"`. Obtain access through the [official DeepSeek platform](https://platform.deepseek.com/). The config reads `COSMOSALPHA_LLM_API_KEY`; `COSMOSALPHA_LLM_BASE_URL` is an optional endpoint override. Keep keys in the approved secret mechanism, not in TOML, reports or chat.

There is a version distinction to record. The [paper’s main experiment](https://arxiv.org/html/2611.04555v1) reports DeepSeek-V4-Flash. The [current official API guide](https://api-docs.deepseek.com/) says `deepseek-flash` and the retired legacy Flash aliases now serve DeepSeek-V4.1-Flash-1017. Using the current endpoint is a declared backbone-version replication arm; it does not prove the original model is still served. Capture the actual returned model and all call/usage receipts.

The [live Flash pricing page](https://api-docs.deepseek.com/quick_start/pricing/) lists USD per million tokens:

| Token category | Off-peak | Peak |
|---|---:|---:|
| Input, cache miss | $0.15 | $0.30 |
| Input, cache hit | $0.003 | $0.006 |
| Output | $0.60 | $1.20 |

Peak is 01:00–04:00 and 06:00–10:00 UTC on weekdays, excluding Chinese public holidays. Other times are off-peak. These are published rates, not actual experiment charges.

The paper reports about 1.56 million input and 2.41 million output tokens for a 100-expansion DeepSeek Graph run. At current uncached rates, that token mix would cost about $1.68 off-peak or $3.36 peak. This is a price illustration, not a run budget or upper bound: the authors say their token totals are lower bounds because some terminal records lack usage. Initialization, retries, repair calls, model changes and matched Chain runs need their own accounting. The reported 6.17 hours are cumulative model-call time, not measured wall time for this installation. Freeze a bounded experiment budget and require complete charged usage before any paid run.

## Preparation completed here

The pinned author package’s model extra is installed with Python 3.12.9, Qlib 0.9.7, LightGBM 4.7.0 and NumPy 2.5.4. A checksum-verified, task-local LLVM OpenMP library resolves the macOS LightGBM dependency. Qlib and LightGBM import successfully. All 13 retained upstream offline tests and eight independent graph/numerical checks pass in that environment. The earlier Python 3.14 environment and its results remain retained.

The original 536,128,200-byte bundle was downloaded, matched its publisher MD5 and received SHA-256 `fbe16e9e555562a6d9d4943628aa1dcddd87afcb0be545d7891b08f9cb8882c7`. Every ZIP member passed CRC checks. All three providers were extracted with identical calendar and CSI300 file hashes.

The authors’ native loader completed the unchanged reference window and warmup: 2,286 dates, 629 historical instruments and 685,511 samples. An independent audit verified all four persisted artifact hashes, matching market/exposure/mask keys, no duplicate keys and valid observed OHLC prices. Every evaluation date has at least 200 eligible instruments, exceeding the 100-stock minimum.

The inputs remain sparse. Among eligible rows, 158 lack `free_turn`, three lack `returns` and 279 lack industry IDs. There are 310 missing industry IDs across all rows. Null values remain null; industry-dependent operators and neutralization exclude unknown industries. The industry point-in-time warning remains. These checks establish source integrity and observed cross-section, not factor admission, complete coverage for every expression or profit.

The original path-only DeepSeek preflights failed on a missing model key. That was a limitation of the selected paid-provider configuration, not a missing inference capability. All six amended self-hosted configurations now pass native preflight, and the first Graph run has started. Its first native hypothesis call returned valid structured output and usage. No DeepSeek call, purchase, new credential or provider account was needed. The [reference comparison](cosmosalpha-reference-budget-2026-11-07.md) records the shared proposal allowance and declared backend changes. No completed comparison, native strategy qualification or trading authority is established.

## Why the other public archives are not the default

The [chenditc November 4 archive](https://github.com/chenditc/investment_data/releases/tag/2026-11-04) was downloaded and passed its publisher’s checksum/provenance validator. Its ten binary fields cover 6,174 instruments, but it lacks CosmosAlpha’s turnover, industry, capitalization and mask fields.

The [xu-duqing November 6 daily-basic increment](https://github.com/xu-duqing/investment_data/releases/tag/2026-11-06) was downloaded and matched GitHub’s SHA-256. Its internal manifest declares a January 2, 2020–November 6, 2026 source window and binds a separate base calendar. It is not a standalone provider and does not cover the frozen 2010–2019 reference period. Its 2000-start base calendar must not be mistaken for finite daily-basic observations since 2000. Do not shorten the experiment or fill the missing years to use this package.

Tushare remains a reconstruction route through `daily`, `daily_basic`, `index_member_all`, `stock_basic`, `index_weight`, `stk_limit` and `suspend_d`. Its [individual access table](https://tushare.pro/document/1?doc_id=290) lists 2,000 points at CNY 200 per year and 5,000 points at CNY 500; institutional pricing is listed separately at ten times individual rates. A subscription is not needed merely to obtain the linked original bundle. Historical coverage and publication/revision lineage would still require validation after vendor access.

A rebuild also has a semantic trap: the author field catalog defines `turn` relative to total shares, while Tushare’s [turnover_rate](https://tushare.pro/document/2?doc_id=32) uses unrestricted floating shares. These are not interchangeable. Preserve units and adjustment conventions, and do not blend normalized Qlib volume with raw share counts. Baostock’s live historical-industry probe timed out here; that establishes a transport limitation, not the absence of historical data. A pinned public Dolt listing table was retrieved, but listing dates alone do not complete the reference inputs.

The profitability goal remains active; source availability does not establish economic edge.
