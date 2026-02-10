# Changelog

## [0.6.0](https://github.com/proompteng/lab/compare/temporal-bun-sdk-v0.5.0...temporal-bun-sdk-v0.6.0) (2026-02-09)


### Features

* **codex:** implement autonomous pipeline ([#2329](https://github.com/proompteng/lab/issues/2329)) ([#2333](https://github.com/proompteng/lab/issues/2333)) ([faaa00a](https://github.com/proompteng/lab/commit/faaa00ab1b6ae661d768d1ea870c3b3fd37751d5))
* **temporal-bun-sdk:** add workflow nondeterminism guardrails ([#2934](https://github.com/proompteng/lab/issues/2934)) ([c55ac86](https://github.com/proompteng/lab/commit/c55ac86700b422f01606dc33018e72b724e46c93))


### Bug Fixes

* **argo:** add nats-context artifact output ([#2322](https://github.com/proompteng/lab/issues/2322)) ([5c8df5b](https://github.com/proompteng/lab/commit/5c8df5b70ab0ec01edd2384f53c95645dff39746))
* build proompteng with bun turbo ([#2471](https://github.com/proompteng/lab/issues/2471)) ([b45fb97](https://github.com/proompteng/lab/commit/b45fb97ea12dfff6f207b90c06b30f796605961b))
* **bumba:** prevent enrichFile nondeterminism ([#2930](https://github.com/proompteng/lab/issues/2930)) ([637f7ce](https://github.com/proompteng/lab/commit/637f7cecb5ebc7455f1fb8c2ec4d1a74d52f6aa5))

## [0.5.0](https://github.com/proompteng/lab/compare/temporal-bun-sdk-v0.4.0...temporal-bun-sdk-v0.5.0) (2026-01-09)


### Features

* add inbound workflow signal and query support ([#1825](https://github.com/proompteng/lab/issues/1825)) ([a093aff](https://github.com/proompteng/lab/commit/a093aff67536df42d2ece3dffc28d17d70991cae))
* add observability layer to temporal-bun-sdk ([#1770](https://github.com/proompteng/lab/issues/1770)) ([66ed9fe](https://github.com/proompteng/lab/commit/66ed9feb5f419321b7026c8b0ccccc85d1ce5408))
* add payload codec and failure converter stack ([#1852](https://github.com/proompteng/lab/issues/1852)) ([c94f93a](https://github.com/proompteng/lab/commit/c94f93a4d3aee54074a8c31465d79b9ab04fe39b))
* add repository enrichment workflow ([#2074](https://github.com/proompteng/lab/issues/2074)) ([9e96d7f](https://github.com/proompteng/lab/commit/9e96d7f6873ccfd16fc0442d6eebc4ad8c60459b))
* add temporal-bun replay CLI ([#1784](https://github.com/proompteng/lab/issues/1784)) ([#1785](https://github.com/proompteng/lab/issues/1785)) ([b4e8b76](https://github.com/proompteng/lab/commit/b4e8b763c6182c2d3c6b58ac0638c2184ef70a9b))
* add worker load/perf tests ([#1782](https://github.com/proompteng/lab/issues/1782)) ([c6e3cf4](https://github.com/proompteng/lab/commit/c6e3cf405ceb6da3459aefd1b2f7056316b554e1))
* add workflow update executor plumbing ([#1824](https://github.com/proompteng/lab/issues/1824)) ([335c6e8](https://github.com/proompteng/lab/commit/335c6e8a265aa952305fb787cdf90c842662c281))
* **codex:** implement autonomous pipeline ([#2329](https://github.com/proompteng/lab/issues/2329)) ([#2333](https://github.com/proompteng/lab/issues/2333)) ([faaa00a](https://github.com/proompteng/lab/commit/faaa00ab1b6ae661d768d1ea870c3b3fd37751d5))
* expand workflow command coverage ([#1817](https://github.com/proompteng/lab/issues/1817)) ([#1834](https://github.com/proompteng/lab/issues/1834)) ([8dc276e](https://github.com/proompteng/lab/commit/8dc276e641a7665e3312e43ace1fb126ed1cd341))
* finish Effect layer refactor for temporal-bun-sdk ([#1792](https://github.com/proompteng/lab/issues/1792)) ([e546652](https://github.com/proompteng/lab/commit/e546652622f70b67492a6524f2f65ea7ada37532))
* finish history replay and sticky cache ([#1707](https://github.com/proompteng/lab/issues/1707)) ([#1708](https://github.com/proompteng/lab/issues/1708)) ([2d0fdd0](https://github.com/proompteng/lab/commit/2d0fdd0a9843efa3b120a774d7a5a7ed296dd694))
* harden Temporal Bun SDK client resilience ([#1781](https://github.com/proompteng/lab/issues/1781)) ([ccbe32b](https://github.com/proompteng/lab/commit/ccbe32be1a151d2f7403253fc0958c8d00338505))
* improve bumba enrichment and otel wiring ([#2084](https://github.com/proompteng/lab/issues/2084)) ([6611e0c](https://github.com/proompteng/lab/commit/6611e0c206d292bff1d6e9bce860ddb331cd5d76))
* interceptor framework for temporal-bun-sdk ([#1841](https://github.com/proompteng/lab/issues/1841)) ([#1843](https://github.com/proompteng/lab/issues/1843)) ([12b3646](https://github.com/proompteng/lab/commit/12b36463a782d157dc4c843a75b374abec308cbd))
* **observability:** codex pipeline Kafka/NATS/Jangar ([#2252](https://github.com/proompteng/lab/issues/2252)) ([#2255](https://github.com/proompteng/lab/issues/2255)) ([a7ffc25](https://github.com/proompteng/lab/commit/a7ffc258a3e2fb68d1e3c18b45089cd4f05c11c3))
* **temporal-bun-sdk:** reduce determinism marker chatter ([#2106](https://github.com/proompteng/lab/issues/2106)) ([d49ac1d](https://github.com/proompteng/lab/commit/d49ac1dffcb595035e494727b6427cb394911aa6))
* wire opentelemetry for bumba worker ([#2079](https://github.com/proompteng/lab/issues/2079)) ([9395e0c](https://github.com/proompteng/lab/commit/9395e0cd1c53bdcae301c2f8a5bf32045a3c3d8b))


### Bug Fixes

* **argo:** add nats-context artifact output ([#2322](https://github.com/proompteng/lab/issues/2322)) ([5c8df5b](https://github.com/proompteng/lab/commit/5c8df5b70ab0ec01edd2384f53c95645dff39746))
* avoid child workflow id collisions across runs ([996af98](https://github.com/proompteng/lab/commit/996af98604440a7b071c7aaff303661da57d6585))
* **bonjour:** switch to bun-only build ([#2234](https://github.com/proompteng/lab/issues/2234)) ([580ef40](https://github.com/proompteng/lab/commit/580ef40a0fe447f9226b241559ea8131534bb6fe))
* **bumba:** stop otlp timeout noise ([#2101](https://github.com/proompteng/lab/issues/2101)) ([f6e2161](https://github.com/proompteng/lab/commit/f6e2161880d95958879ef9256a6839bd71ecd911))
* **bumba:** throttle repo indexing concurrency ([#2086](https://github.com/proompteng/lab/issues/2086)) ([45cc3e7](https://github.com/proompteng/lab/commit/45cc3e71eddfc4c1ae9e7a76d4db394a3f323987))
* finalize temporal bun sdk ga readiness ([#1813](https://github.com/proompteng/lab/issues/1813)) ([0429122](https://github.com/proompteng/lab/commit/0429122c9fad087944a30322a250c83f12ed9436))
* handle temporal poll timeouts and update kubectl install ([#1898](https://github.com/proompteng/lab/issues/1898)) ([039eed4](https://github.com/proompteng/lab/commit/039eed4b5a02fdb43855820fa40726f28bef8381))
* handle temporal query-only tasks ([#1816](https://github.com/proompteng/lab/issues/1816)) ([#1836](https://github.com/proompteng/lab/issues/1836)) ([26435b7](https://github.com/proompteng/lab/commit/26435b76152e6feed09578f0f852cb9cfe6ad404))
* move bumba workflow work into activities ([#2067](https://github.com/proompteng/lab/issues/2067)) ([31575ed](https://github.com/proompteng/lab/commit/31575ed6127a23f4d62cdf0e7df13adb91f89855))
* register build-id compatibility for Bun worker ([#1765](https://github.com/proompteng/lab/issues/1765)) ([4a359bf](https://github.com/proompteng/lab/commit/4a359bfdbfd84ee708da24b232ef95c0515dec42))
* remove zig bootstrap step ([#1763](https://github.com/proompteng/lab/issues/1763)) ([6426a85](https://github.com/proompteng/lab/commit/6426a85e0991653a273d8a3b31008f4b5006f949))
* **temporal-bun-sdk:** avoid child workflow id collisions ([#2085](https://github.com/proompteng/lab/issues/2085)) ([996af98](https://github.com/proompteng/lab/commit/996af98604440a7b071c7aaff303661da57d6585))

## [0.4.0](https://github.com/proompteng/lab/compare/temporal-bun-sdk-v0.3.0...temporal-bun-sdk-v0.4.0) (2025-12-06)


### Features

* add bun core bridge runtime ([#1440](https://github.com/proompteng/lab/issues/1440)) ([2cfe05f](https://github.com/proompteng/lab/commit/2cfe05f3549cc46d94f9a9545cee6db7393973ba))
* add bun temporal cli scaffolding ([#1419](https://github.com/proompteng/lab/issues/1419)) ([48a50d6](https://github.com/proompteng/lab/commit/48a50d6cda5bdb94124a1a0f2537bea49a6a0dc0))
* add bun workflow runtime ([#1614](https://github.com/proompteng/lab/issues/1614)) ([2dfb8e8](https://github.com/proompteng/lab/commit/2dfb8e87a83597dfaf70b2a2d468c935364b27a6))
* add bun-native workflow start support ([#1441](https://github.com/proompteng/lab/issues/1441)) ([832f1a3](https://github.com/proompteng/lab/commit/832f1a383f7c83f25e4977e79ef51f97c27a848b))
* add byte-array telemetry guardrails ([#1654](https://github.com/proompteng/lab/issues/1654)) ([17e8974](https://github.com/proompteng/lab/commit/17e897433af0cf97c835300ca2a0e00913cbf707))
* add deterministic replay harness ([#1659](https://github.com/proompteng/lab/issues/1659)) ([#1663](https://github.com/proompteng/lab/issues/1663)) ([fdd2b23](https://github.com/proompteng/lab/commit/fdd2b23e3b196b4c47c845413f42b86e14d6437b))
* add deterministic workflow context ([#1690](https://github.com/proompteng/lab/issues/1690)) ([3f59eb5](https://github.com/proompteng/lab/commit/3f59eb5d87340a1f0b90e37b1ea420f4bc5f5063))
* add inbound workflow signal and query support ([#1825](https://github.com/proompteng/lab/issues/1825)) ([a093aff](https://github.com/proompteng/lab/commit/a093aff67536df42d2ece3dffc28d17d70991cae))
* add observability layer to temporal-bun-sdk ([#1770](https://github.com/proompteng/lab/issues/1770)) ([66ed9fe](https://github.com/proompteng/lab/commit/66ed9feb5f419321b7026c8b0ccccc85d1ce5408))
* add payload codec and failure converter stack ([#1852](https://github.com/proompteng/lab/issues/1852)) ([c94f93a](https://github.com/proompteng/lab/commit/c94f93a4d3aee54074a8c31465d79b9ab04fe39b))
* add payload data converter for temporal bun sdk ([#1633](https://github.com/proompteng/lab/issues/1633)) ([33a544f](https://github.com/proompteng/lab/commit/33a544fed5d16e805f1a949df8d5c27bf4900785))
* add signal-with-start support to bun client ([#1464](https://github.com/proompteng/lab/issues/1464)) ([6af35a8](https://github.com/proompteng/lab/commit/6af35a8b2d924081dd29a0b5f4f6e9855e995a3e)), closes [#1451](https://github.com/proompteng/lab/issues/1451)
* add temporal api stubs for bun sdk ([#1685](https://github.com/proompteng/lab/issues/1685)) ([b8b3f34](https://github.com/proompteng/lab/commit/b8b3f343d0405d8b0ce7934e05478c619673f271))
* add temporal bun check command ([#1439](https://github.com/proompteng/lab/issues/1439)) ([64d15c9](https://github.com/proompteng/lab/commit/64d15c9a597b7a76e1d6bdef8827a65d6ba1e912))
* add temporal-bun replay CLI ([#1784](https://github.com/proompteng/lab/issues/1784)) ([#1785](https://github.com/proompteng/lab/issues/1785)) ([b4e8b76](https://github.com/proompteng/lab/commit/b4e8b763c6182c2d3c6b58ac0638c2184ef70a9b))
* add worker concurrency scheduler ([#1695](https://github.com/proompteng/lab/issues/1695)) ([#1699](https://github.com/proompteng/lab/issues/1699)) ([76445ab](https://github.com/proompteng/lab/commit/76445abf6045b3aa8cc3a6a5a3642df27886864d))
* add worker load/perf tests ([#1782](https://github.com/proompteng/lab/issues/1782)) ([c6e3cf4](https://github.com/proompteng/lab/commit/c6e3cf405ceb6da3459aefd1b2f7056316b554e1))
* add workflow query support to bun client ([#1468](https://github.com/proompteng/lab/issues/1468)) ([500d8eb](https://github.com/proompteng/lab/commit/500d8eb778796747b2155bb42051d9b894f59757)), closes [#1448](https://github.com/proompteng/lab/issues/1448)
* add workflow termination support in bun client ([#1469](https://github.com/proompteng/lab/issues/1469)) ([6b9428a](https://github.com/proompteng/lab/commit/6b9428a6150515e4be034b9d3c20aaa26a16752d))
* add workflow update executor plumbing ([#1824](https://github.com/proompteng/lab/issues/1824)) ([335c6e8](https://github.com/proompteng/lab/commit/335c6e8a265aa952305fb787cdf90c842662c281))
* add zig query bridge ([#1583](https://github.com/proompteng/lab/issues/1583)) ([82ce64f](https://github.com/proompteng/lab/commit/82ce64f8fb351b91259720afd1cd6541e48808fb))
* add zig worker activity polling ([#1597](https://github.com/proompteng/lab/issues/1597)) ([12c58be](https://github.com/proompteng/lab/commit/12c58beb667240380213decfe4719beecca0e8d7))
* add zig worker workflow polling ([#1592](https://github.com/proompteng/lab/issues/1592)) ([852187e](https://github.com/proompteng/lab/commit/852187e551ada5d356dacf5efa666945153d8593))
* add zig workflow cancel support [#1499](https://github.com/proompteng/lab/issues/1499) ([#1621](https://github.com/proompteng/lab/issues/1621)) ([8cf8d4b](https://github.com/proompteng/lab/commit/8cf8d4bb2bd18662279827067ab84acfbcbd6c10))
* add zig workflow signal bridge ([#1498](https://github.com/proompteng/lab/issues/1498)) ([#1523](https://github.com/proompteng/lab/issues/1523)) ([095a755](https://github.com/proompteng/lab/commit/095a7555a6733723dc9ac560de907a3e2429f52b))
* adopt effect workflow runtime ([#1688](https://github.com/proompteng/lab/issues/1688)) ([3057e18](https://github.com/proompteng/lab/commit/3057e18838f12afff4ed3a87d06badabe849218e))
* async client connect for bun bridge ([#1438](https://github.com/proompteng/lab/issues/1438)) ([6e754fd](https://github.com/proompteng/lab/commit/6e754fd1853528c913d51181a21bd63758c0f40d))
* enable zero-copy Temporal byte arrays ([#1521](https://github.com/proompteng/lab/issues/1521)) ([35f671c](https://github.com/proompteng/lab/commit/35f671cf867fc14a51afc050bf99ee38a6bd1e28))
* enable zig worker polling loops ([#1608](https://github.com/proompteng/lab/issues/1608)) ([20628c5](https://github.com/proompteng/lab/commit/20628c5f08edc86a04fea14691c92bc1866b54b5))
* expand workflow command coverage ([#1817](https://github.com/proompteng/lab/issues/1817)) ([#1834](https://github.com/proompteng/lab/issues/1834)) ([8dc276e](https://github.com/proompteng/lab/commit/8dc276e641a7665e3312e43ace1fb126ed1cd341))
* finalize Zig worker shutdown ([#1628](https://github.com/proompteng/lab/issues/1628)) ([593d220](https://github.com/proompteng/lab/commit/593d2202ec616629d18297e9b41907effba662c4))
* finish Effect layer refactor for temporal-bun-sdk ([#1792](https://github.com/proompteng/lab/issues/1792)) ([e546652](https://github.com/proompteng/lab/commit/e546652622f70b67492a6524f2f65ea7ada37532))
* finish history replay and sticky cache ([#1707](https://github.com/proompteng/lab/issues/1707)) ([#1708](https://github.com/proompteng/lab/issues/1708)) ([2d0fdd0](https://github.com/proompteng/lab/commit/2d0fdd0a9843efa3b120a774d7a5a7ed296dd694))
* forward temporal core logs via zig bridge ([#1624](https://github.com/proompteng/lab/issues/1624)) ([c6b1a68](https://github.com/proompteng/lab/commit/c6b1a6849b44bbf4bde3e00e40681d5e3365466d))
* harden pending handle state machine ([#1526](https://github.com/proompteng/lab/issues/1526)) ([de9153d](https://github.com/proompteng/lab/commit/de9153d46cdbf5b95a8a81d028d17cfa9b796cc0))
* harden Temporal Bun SDK client resilience ([#1781](https://github.com/proompteng/lab/issues/1781)) ([ccbe32b](https://github.com/proompteng/lab/commit/ccbe32be1a151d2f7403253fc0958c8d00338505))
* implement activity lifecycle ([#1703](https://github.com/proompteng/lab/issues/1703)) ([435465f](https://github.com/proompteng/lab/commit/435465f31b94d1e08782f00e5d80d1a1c3058696))
* implement client metadata bridge updates ([#1607](https://github.com/proompteng/lab/issues/1607)) ([22d3c5a](https://github.com/proompteng/lab/commit/22d3c5a0838ac4f205c8eba89e63e3d5b3f4556a))
* implement temporal static library publishing system ([#1567](https://github.com/proompteng/lab/issues/1567)) ([19b0147](https://github.com/proompteng/lab/commit/19b0147f23d4bbd4646d18425f0de39d01a798b4))
* implement zig workflow completion bridge ([#1522](https://github.com/proompteng/lab/issues/1522)) ([2995c82](https://github.com/proompteng/lab/commit/2995c8217f10806879543443fb9550b3c192628a))
* ingest Temporal histories into determinism cache ([#1700](https://github.com/proompteng/lab/issues/1700)) ([8fbab2a](https://github.com/proompteng/lab/commit/8fbab2a3e3efc2e8ebef9161c9dc3cb1d54cbccd))
* initialize Zig runtime via Temporal core ([#1549](https://github.com/proompteng/lab/issues/1549)) ([331e005](https://github.com/proompteng/lab/commit/331e0051edb72a7631f7a4447d6fb6b29d1ea11d)), closes [#1487](https://github.com/proompteng/lab/issues/1487)
* instantiate zig worker handles ([#1590](https://github.com/proompteng/lab/issues/1590)) ([0a343d3](https://github.com/proompteng/lab/commit/0a343d35db1228193efa8c6ca0a5e2e19c29ec46))
* interceptor framework for temporal-bun-sdk ([#1841](https://github.com/proompteng/lab/issues/1841)) ([#1843](https://github.com/proompteng/lab/issues/1843)) ([12b3646](https://github.com/proompteng/lab/commit/12b36463a782d157dc4c843a75b374abec308cbd))
* link Zig bridge against Temporal core ([#1533](https://github.com/proompteng/lab/issues/1533)) ([69e7e46](https://github.com/proompteng/lab/commit/69e7e469ceb57411a7ea7989b1233e13a6a876d4))
* package zig bridge artifacts ([#1514](https://github.com/proompteng/lab/issues/1514)) ([#1530](https://github.com/proompteng/lab/issues/1530)) ([1e02804](https://github.com/proompteng/lab/commit/1e0280469eac44c02d7b897efb7a9234eceecf87))
* pool pending handles in temporal-bun-sdk ([#1657](https://github.com/proompteng/lab/issues/1657)) ([fd59b7a](https://github.com/proompteng/lab/commit/fd59b7a41e853565c6e6ba6de75e9b76c9820b26))
* return workflow handles from Bun start API ([#1467](https://github.com/proompteng/lab/issues/1467)) ([b49cdff](https://github.com/proompteng/lab/commit/b49cdff151ea180866e584ce9cd9ee1f8e99f1ad))
* scaffold Bun Temporal SDK bridge ([#1387](https://github.com/proompteng/lab/issues/1387)) ([d3be4a0](https://github.com/proompteng/lab/commit/d3be4a0969a96daab721e494c261a182f46fa53f))
* scaffold temporal bun sdk execution tracks ([#1692](https://github.com/proompteng/lab/issues/1692)) ([fbb4401](https://github.com/proompteng/lab/commit/fbb44016cc6f807b3033aa29cb24233af1317201))
* support client metadata updates via Bun bridge ([#1472](https://github.com/proompteng/lab/issues/1472)) ([7153331](https://github.com/proompteng/lab/commit/71533318bb98972bec24faacb1996e8f8997b3ba))
* support graceful Zig worker shutdown ([#1511](https://github.com/proompteng/lab/issues/1511)) ([#1622](https://github.com/proompteng/lab/issues/1622)) ([fef8c7e](https://github.com/proompteng/lab/commit/fef8c7e0b0ed9fe59af356b298a1b5d7dd928186))
* surface codex tool-call telemetry ([#1664](https://github.com/proompteng/lab/issues/1664)) ([a591357](https://github.com/proompteng/lab/commit/a5913575d3811b8e05567e48f09b86e738756275))
* surface structured pending errors in zig bridge ([#1525](https://github.com/proompteng/lab/issues/1525)) ([4270c97](https://github.com/proompteng/lab/commit/4270c97a4db5353a25224beac4e25722acdc736d))
* **temporal-bun-sdk:** signalWithStart (Zig+TS), tests, CI biome ([#1586](https://github.com/proompteng/lab/issues/1586)) ([ea8c4c7](https://github.com/proompteng/lab/commit/ea8c4c7c06ad6495bc0f4fcfe85d9571bcf87bde))
* vendor Temporal core header for Zig bridge ([#1528](https://github.com/proompteng/lab/issues/1528)) ([e297896](https://github.com/proompteng/lab/commit/e297896ba91be7de2734a0251d5cfd8c14a86c23))
* wire zig client connect to Temporal core ([#1552](https://github.com/proompteng/lab/issues/1552)) ([819bbad](https://github.com/proompteng/lab/commit/819bbad9f1733ea157d514c26e563e9e37de2ede))
* wire zig describe namespace bridge ([#1492](https://github.com/proompteng/lab/issues/1492)) ([#1529](https://github.com/proompteng/lab/issues/1529)) ([f289ada](https://github.com/proompteng/lab/commit/f289adabbec73e00d3f7ed1e996c9d69a238ed41))
* wire zig start workflow ([#1580](https://github.com/proompteng/lab/issues/1580)) ([9e84903](https://github.com/proompteng/lab/commit/9e84903090f071824da00366900b09f19276b470))
* wire zig terminate workflow bridge ([#1587](https://github.com/proompteng/lab/issues/1587)) ([eefd738](https://github.com/proompteng/lab/commit/eefd738e12264494cf5b7aa1a9399f07f0a9a0a1))
* wire zig worker teardown ([#1505](https://github.com/proompteng/lab/issues/1505)) ([#1596](https://github.com/proompteng/lab/issues/1596)) ([2f4aed7](https://github.com/proompteng/lab/commit/2f4aed7b01e481fcba08410824ffc645c6966676))


### Bug Fixes

* enforce temporal core c abi bridge ([#1679](https://github.com/proompteng/lab/issues/1679)) ([7f9479b](https://github.com/proompteng/lab/commit/7f9479b5c600f3250d1507dfddca8253b81a52f5))
* ensure bun worker passes build id ([#1676](https://github.com/proompteng/lab/issues/1676)) ([e41df16](https://github.com/proompteng/lab/commit/e41df16edcf4f93db66efaf2eb5afd35e9ba7a86))
* ensure zig worker build id is reachable ([#1682](https://github.com/proompteng/lab/issues/1682)) ([d55cc44](https://github.com/proompteng/lab/commit/d55cc44655a871a015cfa613498936e4c558dc94))
* finalize temporal bun sdk ga readiness ([#1813](https://github.com/proompteng/lab/issues/1813)) ([0429122](https://github.com/proompteng/lab/commit/0429122c9fad087944a30322a250c83f12ed9436))
* flush temporal runtime logs ([#1681](https://github.com/proompteng/lab/issues/1681)) ([4950766](https://github.com/proompteng/lab/commit/4950766f47c5d7b8bade79d33bf72c53a1ed1a15))
* guard temporal worker pointer mismatch ([#1674](https://github.com/proompteng/lab/issues/1674)) ([9bca3aa](https://github.com/proompteng/lab/commit/9bca3aabbcba815bfd0e3e4cbe8a7671184b7ad3))
* handle temporal poll timeouts and update kubectl install ([#1898](https://github.com/proompteng/lab/issues/1898)) ([039eed4](https://github.com/proompteng/lab/commit/039eed4b5a02fdb43855820fa40726f28bef8381))
* handle temporal query-only tasks ([#1816](https://github.com/proompteng/lab/issues/1816)) ([#1836](https://github.com/proompteng/lab/issues/1836)) ([26435b7](https://github.com/proompteng/lab/commit/26435b76152e6feed09578f0f852cb9cfe6ad404))
* keep kafka kustomize build options ([#1361](https://github.com/proompteng/lab/issues/1361)) ([bde2495](https://github.com/proompteng/lab/commit/bde24954b29f84bb29f5a6b77652121641b22fe4))
* normalize temporal core ffi signatures ([#1675](https://github.com/proompteng/lab/issues/1675)) ([d94a601](https://github.com/proompteng/lab/commit/d94a601af6b334d61311ffbe13855ea48bab0a51))
* register build-id compatibility for Bun worker ([#1765](https://github.com/proompteng/lab/issues/1765)) ([4a359bf](https://github.com/proompteng/lab/commit/4a359bfdbfd84ee708da24b232ef95c0515dec42))
* remove zig bootstrap step ([#1763](https://github.com/proompteng/lab/issues/1763)) ([6426a85](https://github.com/proompteng/lab/commit/6426a85e0991653a273d8a3b31008f4b5006f949))
* route zig signal workflow to temporal core ([#1601](https://github.com/proompteng/lab/issues/1601)) ([1b42769](https://github.com/proompteng/lab/commit/1b42769d791a1260a1ed65f494afd66535694b87))
* sync cancellation docs and stabilize telemetry tests ([#1604](https://github.com/proompteng/lab/issues/1604)) ([#1661](https://github.com/proompteng/lab/issues/1661)) ([400ae93](https://github.com/proompteng/lab/commit/400ae93858be3a89c0d672e5620ec30440db0a22))
* **temporal-bun-sdk:** fix Zig compilation errors and align platform support ([#1573](https://github.com/proompteng/lab/issues/1573)) ([5c3611f](https://github.com/proompteng/lab/commit/5c3611fcc5cacba5a12325cd90679cd6bdd27510))
* unblock telemetry metrics configuration ([#1471](https://github.com/proompteng/lab/issues/1471)) ([4e0d329](https://github.com/proompteng/lab/commit/4e0d3294e8a38426420579f0e5782172cf93e521))
* wire Zig telemetry configuration ([#1489](https://github.com/proompteng/lab/issues/1489)) ([#1627](https://github.com/proompteng/lab/issues/1627)) ([599f5a9](https://github.com/proompteng/lab/commit/599f5a976fd63460311941af00ed9775c57ce2c2))
* wire zig workflow completion bridge ([#1589](https://github.com/proompteng/lab/issues/1589)) ([#1591](https://github.com/proompteng/lab/issues/1591)) ([e464ce7](https://github.com/proompteng/lab/commit/e464ce73eb775f0df4a13f2a1323fde2e1dcc54f))


### Performance Improvements

* pool Bun bridge byte arrays ([#1461](https://github.com/proompteng/lab/issues/1461)) ([3a241a0](https://github.com/proompteng/lab/commit/3a241a05176fc322eb965b9b13398e9ac1d7b4d4))

## [0.3.0](https://github.com/proompteng/lab/compare/temporal-bun-sdk-v0.2.0...temporal-bun-sdk-v0.3.0) (2025-11-20)


### Features

* add inbound workflow signal and query support ([#1825](https://github.com/proompteng/lab/issues/1825)) ([a093aff](https://github.com/proompteng/lab/commit/a093aff67536df42d2ece3dffc28d17d70991cae))
* add workflow update executor plumbing ([#1824](https://github.com/proompteng/lab/issues/1824)) ([335c6e8](https://github.com/proompteng/lab/commit/335c6e8a265aa952305fb787cdf90c842662c281))


### Bug Fixes

* finalize temporal bun sdk ga readiness ([#1813](https://github.com/proompteng/lab/issues/1813)) ([0429122](https://github.com/proompteng/lab/commit/0429122c9fad087944a30322a250c83f12ed9436))

## [0.2.0](https://github.com/proompteng/lab/compare/v0.1.0...v0.2.0) (2025-11-17)


### Features

* add bun core bridge runtime ([#1440](https://github.com/proompteng/lab/issues/1440)) ([2cfe05f](https://github.com/proompteng/lab/commit/2cfe05f3549cc46d94f9a9545cee6db7393973ba))
* add bun temporal cli scaffolding ([#1419](https://github.com/proompteng/lab/issues/1419)) ([48a50d6](https://github.com/proompteng/lab/commit/48a50d6cda5bdb94124a1a0f2537bea49a6a0dc0))
* add bun workflow runtime ([#1614](https://github.com/proompteng/lab/issues/1614)) ([2dfb8e8](https://github.com/proompteng/lab/commit/2dfb8e87a83597dfaf70b2a2d468c935364b27a6))
* add bun-native workflow start support ([#1441](https://github.com/proompteng/lab/issues/1441)) ([832f1a3](https://github.com/proompteng/lab/commit/832f1a383f7c83f25e4977e79ef51f97c27a848b))
* add byte-array telemetry guardrails ([#1654](https://github.com/proompteng/lab/issues/1654)) ([17e8974](https://github.com/proompteng/lab/commit/17e897433af0cf97c835300ca2a0e00913cbf707))
* add deterministic replay harness ([#1659](https://github.com/proompteng/lab/issues/1659)) ([#1663](https://github.com/proompteng/lab/issues/1663)) ([fdd2b23](https://github.com/proompteng/lab/commit/fdd2b23e3b196b4c47c845413f42b86e14d6437b))
* add deterministic workflow context ([#1690](https://github.com/proompteng/lab/issues/1690)) ([3f59eb5](https://github.com/proompteng/lab/commit/3f59eb5d87340a1f0b90e37b1ea420f4bc5f5063))
* add observability layer to temporal-bun-sdk ([#1770](https://github.com/proompteng/lab/issues/1770)) ([66ed9fe](https://github.com/proompteng/lab/commit/66ed9feb5f419321b7026c8b0ccccc85d1ce5408))
* add payload data converter for temporal bun sdk ([#1633](https://github.com/proompteng/lab/issues/1633)) ([33a544f](https://github.com/proompteng/lab/commit/33a544fed5d16e805f1a949df8d5c27bf4900785))
* add signal-with-start support to bun client ([#1464](https://github.com/proompteng/lab/issues/1464)) ([6af35a8](https://github.com/proompteng/lab/commit/6af35a8b2d924081dd29a0b5f4f6e9855e995a3e)), closes [#1451](https://github.com/proompteng/lab/issues/1451)
* add temporal api stubs for bun sdk ([#1685](https://github.com/proompteng/lab/issues/1685)) ([b8b3f34](https://github.com/proompteng/lab/commit/b8b3f343d0405d8b0ce7934e05478c619673f271))
* add temporal bun check command ([#1439](https://github.com/proompteng/lab/issues/1439)) ([64d15c9](https://github.com/proompteng/lab/commit/64d15c9a597b7a76e1d6bdef8827a65d6ba1e912))
* add temporal-bun replay CLI ([#1784](https://github.com/proompteng/lab/issues/1784)) ([#1785](https://github.com/proompteng/lab/issues/1785)) ([b4e8b76](https://github.com/proompteng/lab/commit/b4e8b763c6182c2d3c6b58ac0638c2184ef70a9b))
* add worker concurrency scheduler ([#1695](https://github.com/proompteng/lab/issues/1695)) ([#1699](https://github.com/proompteng/lab/issues/1699)) ([76445ab](https://github.com/proompteng/lab/commit/76445abf6045b3aa8cc3a6a5a3642df27886864d))
* add worker load/perf tests ([#1782](https://github.com/proompteng/lab/issues/1782)) ([c6e3cf4](https://github.com/proompteng/lab/commit/c6e3cf405ceb6da3459aefd1b2f7056316b554e1))
* add workflow query support to bun client ([#1468](https://github.com/proompteng/lab/issues/1468)) ([500d8eb](https://github.com/proompteng/lab/commit/500d8eb778796747b2155bb42051d9b894f59757)), closes [#1448](https://github.com/proompteng/lab/issues/1448)
* add workflow termination support in bun client ([#1469](https://github.com/proompteng/lab/issues/1469)) ([6b9428a](https://github.com/proompteng/lab/commit/6b9428a6150515e4be034b9d3c20aaa26a16752d))
* add zig query bridge ([#1583](https://github.com/proompteng/lab/issues/1583)) ([82ce64f](https://github.com/proompteng/lab/commit/82ce64f8fb351b91259720afd1cd6541e48808fb))
* add zig worker activity polling ([#1597](https://github.com/proompteng/lab/issues/1597)) ([12c58be](https://github.com/proompteng/lab/commit/12c58beb667240380213decfe4719beecca0e8d7))
* add zig worker workflow polling ([#1592](https://github.com/proompteng/lab/issues/1592)) ([852187e](https://github.com/proompteng/lab/commit/852187e551ada5d356dacf5efa666945153d8593))
* add zig workflow cancel support [#1499](https://github.com/proompteng/lab/issues/1499) ([#1621](https://github.com/proompteng/lab/issues/1621)) ([8cf8d4b](https://github.com/proompteng/lab/commit/8cf8d4bb2bd18662279827067ab84acfbcbd6c10))
* add zig workflow signal bridge ([#1498](https://github.com/proompteng/lab/issues/1498)) ([#1523](https://github.com/proompteng/lab/issues/1523)) ([095a755](https://github.com/proompteng/lab/commit/095a7555a6733723dc9ac560de907a3e2429f52b))
* adopt effect workflow runtime ([#1688](https://github.com/proompteng/lab/issues/1688)) ([3057e18](https://github.com/proompteng/lab/commit/3057e18838f12afff4ed3a87d06badabe849218e))
* async client connect for bun bridge ([#1438](https://github.com/proompteng/lab/issues/1438)) ([6e754fd](https://github.com/proompteng/lab/commit/6e754fd1853528c913d51181a21bd63758c0f40d))
* enable zero-copy Temporal byte arrays ([#1521](https://github.com/proompteng/lab/issues/1521)) ([35f671c](https://github.com/proompteng/lab/commit/35f671cf867fc14a51afc050bf99ee38a6bd1e28))
* enable zig worker polling loops ([#1608](https://github.com/proompteng/lab/issues/1608)) ([20628c5](https://github.com/proompteng/lab/commit/20628c5f08edc86a04fea14691c92bc1866b54b5))
* finalize Zig worker shutdown ([#1628](https://github.com/proompteng/lab/issues/1628)) ([593d220](https://github.com/proompteng/lab/commit/593d2202ec616629d18297e9b41907effba662c4))
* finish Effect layer refactor for temporal-bun-sdk ([#1792](https://github.com/proompteng/lab/issues/1792)) ([e546652](https://github.com/proompteng/lab/commit/e546652622f70b67492a6524f2f65ea7ada37532))
* finish history replay and sticky cache ([#1707](https://github.com/proompteng/lab/issues/1707)) ([#1708](https://github.com/proompteng/lab/issues/1708)) ([2d0fdd0](https://github.com/proompteng/lab/commit/2d0fdd0a9843efa3b120a774d7a5a7ed296dd694))
* forward temporal core logs via zig bridge ([#1624](https://github.com/proompteng/lab/issues/1624)) ([c6b1a68](https://github.com/proompteng/lab/commit/c6b1a6849b44bbf4bde3e00e40681d5e3365466d))
* harden pending handle state machine ([#1526](https://github.com/proompteng/lab/issues/1526)) ([de9153d](https://github.com/proompteng/lab/commit/de9153d46cdbf5b95a8a81d028d17cfa9b796cc0))
* harden Temporal Bun SDK client resilience ([#1781](https://github.com/proompteng/lab/issues/1781)) ([ccbe32b](https://github.com/proompteng/lab/commit/ccbe32be1a151d2f7403253fc0958c8d00338505))
* implement activity lifecycle ([#1703](https://github.com/proompteng/lab/issues/1703)) ([435465f](https://github.com/proompteng/lab/commit/435465f31b94d1e08782f00e5d80d1a1c3058696))
* implement client metadata bridge updates ([#1607](https://github.com/proompteng/lab/issues/1607)) ([22d3c5a](https://github.com/proompteng/lab/commit/22d3c5a0838ac4f205c8eba89e63e3d5b3f4556a))
* implement temporal static library publishing system ([#1567](https://github.com/proompteng/lab/issues/1567)) ([19b0147](https://github.com/proompteng/lab/commit/19b0147f23d4bbd4646d18425f0de39d01a798b4))
* implement zig workflow completion bridge ([#1522](https://github.com/proompteng/lab/issues/1522)) ([2995c82](https://github.com/proompteng/lab/commit/2995c8217f10806879543443fb9550b3c192628a))
* ingest Temporal histories into determinism cache ([#1700](https://github.com/proompteng/lab/issues/1700)) ([8fbab2a](https://github.com/proompteng/lab/commit/8fbab2a3e3efc2e8ebef9161c9dc3cb1d54cbccd))
* initialize Zig runtime via Temporal core ([#1549](https://github.com/proompteng/lab/issues/1549)) ([331e005](https://github.com/proompteng/lab/commit/331e0051edb72a7631f7a4447d6fb6b29d1ea11d)), closes [#1487](https://github.com/proompteng/lab/issues/1487)
* instantiate zig worker handles ([#1590](https://github.com/proompteng/lab/issues/1590)) ([0a343d3](https://github.com/proompteng/lab/commit/0a343d35db1228193efa8c6ca0a5e2e19c29ec46))
* link Zig bridge against Temporal core ([#1533](https://github.com/proompteng/lab/issues/1533)) ([69e7e46](https://github.com/proompteng/lab/commit/69e7e469ceb57411a7ea7989b1233e13a6a876d4))
* package zig bridge artifacts ([#1514](https://github.com/proompteng/lab/issues/1514)) ([#1530](https://github.com/proompteng/lab/issues/1530)) ([1e02804](https://github.com/proompteng/lab/commit/1e0280469eac44c02d7b897efb7a9234eceecf87))
* pool pending handles in temporal-bun-sdk ([#1657](https://github.com/proompteng/lab/issues/1657)) ([fd59b7a](https://github.com/proompteng/lab/commit/fd59b7a41e853565c6e6ba6de75e9b76c9820b26))
* return workflow handles from Bun start API ([#1467](https://github.com/proompteng/lab/issues/1467)) ([b49cdff](https://github.com/proompteng/lab/commit/b49cdff151ea180866e584ce9cd9ee1f8e99f1ad))
* scaffold Bun Temporal SDK bridge ([#1387](https://github.com/proompteng/lab/issues/1387)) ([d3be4a0](https://github.com/proompteng/lab/commit/d3be4a0969a96daab721e494c261a182f46fa53f))
* scaffold temporal bun sdk execution tracks ([#1692](https://github.com/proompteng/lab/issues/1692)) ([fbb4401](https://github.com/proompteng/lab/commit/fbb44016cc6f807b3033aa29cb24233af1317201))
* support client metadata updates via Bun bridge ([#1472](https://github.com/proompteng/lab/issues/1472)) ([7153331](https://github.com/proompteng/lab/commit/71533318bb98972bec24faacb1996e8f8997b3ba))
* support graceful Zig worker shutdown ([#1511](https://github.com/proompteng/lab/issues/1511)) ([#1622](https://github.com/proompteng/lab/issues/1622)) ([fef8c7e](https://github.com/proompteng/lab/commit/fef8c7e0b0ed9fe59af356b298a1b5d7dd928186))
* surface codex tool-call telemetry ([#1664](https://github.com/proompteng/lab/issues/1664)) ([a591357](https://github.com/proompteng/lab/commit/a5913575d3811b8e05567e48f09b86e738756275))
* surface structured pending errors in zig bridge ([#1525](https://github.com/proompteng/lab/issues/1525)) ([4270c97](https://github.com/proompteng/lab/commit/4270c97a4db5353a25224beac4e25722acdc736d))
* **temporal-bun-sdk:** signalWithStart (Zig+TS), tests, CI biome ([#1586](https://github.com/proompteng/lab/issues/1586)) ([ea8c4c7](https://github.com/proompteng/lab/commit/ea8c4c7c06ad6495bc0f4fcfe85d9571bcf87bde))
* vendor Temporal core header for Zig bridge ([#1528](https://github.com/proompteng/lab/issues/1528)) ([e297896](https://github.com/proompteng/lab/commit/e297896ba91be7de2734a0251d5cfd8c14a86c23))
* wire zig client connect to Temporal core ([#1552](https://github.com/proompteng/lab/issues/1552)) ([819bbad](https://github.com/proompteng/lab/commit/819bbad9f1733ea157d514c26e563e9e37de2ede))
* wire zig describe namespace bridge ([#1492](https://github.com/proompteng/lab/issues/1492)) ([#1529](https://github.com/proompteng/lab/issues/1529)) ([f289ada](https://github.com/proompteng/lab/commit/f289adabbec73e00d3f7ed1e996c9d69a238ed41))
* wire zig start workflow ([#1580](https://github.com/proompteng/lab/issues/1580)) ([9e84903](https://github.com/proompteng/lab/commit/9e84903090f071824da00366900b09f19276b470))
* wire zig terminate workflow bridge ([#1587](https://github.com/proompteng/lab/issues/1587)) ([eefd738](https://github.com/proompteng/lab/commit/eefd738e12264494cf5b7aa1a9399f07f0a9a0a1))
* wire zig worker teardown ([#1505](https://github.com/proompteng/lab/issues/1505)) ([#1596](https://github.com/proompteng/lab/issues/1596)) ([2f4aed7](https://github.com/proompteng/lab/commit/2f4aed7b01e481fcba08410824ffc645c6966676))


### Bug Fixes

* enforce temporal core c abi bridge ([#1679](https://github.com/proompteng/lab/issues/1679)) ([7f9479b](https://github.com/proompteng/lab/commit/7f9479b5c600f3250d1507dfddca8253b81a52f5))
* ensure bun worker passes build id ([#1676](https://github.com/proompteng/lab/issues/1676)) ([e41df16](https://github.com/proompteng/lab/commit/e41df16edcf4f93db66efaf2eb5afd35e9ba7a86))
* ensure zig worker build id is reachable ([#1682](https://github.com/proompteng/lab/issues/1682)) ([d55cc44](https://github.com/proompteng/lab/commit/d55cc44655a871a015cfa613498936e4c558dc94))
* flush temporal runtime logs ([#1681](https://github.com/proompteng/lab/issues/1681)) ([4950766](https://github.com/proompteng/lab/commit/4950766f47c5d7b8bade79d33bf72c53a1ed1a15))
* guard temporal worker pointer mismatch ([#1674](https://github.com/proompteng/lab/issues/1674)) ([9bca3aa](https://github.com/proompteng/lab/commit/9bca3aabbcba815bfd0e3e4cbe8a7671184b7ad3))
* keep kafka kustomize build options ([#1361](https://github.com/proompteng/lab/issues/1361)) ([bde2495](https://github.com/proompteng/lab/commit/bde24954b29f84bb29f5a6b77652121641b22fe4))
* normalize temporal core ffi signatures ([#1675](https://github.com/proompteng/lab/issues/1675)) ([d94a601](https://github.com/proompteng/lab/commit/d94a601af6b334d61311ffbe13855ea48bab0a51))
* register build-id compatibility for Bun worker ([#1765](https://github.com/proompteng/lab/issues/1765)) ([4a359bf](https://github.com/proompteng/lab/commit/4a359bfdbfd84ee708da24b232ef95c0515dec42))
* remove zig bootstrap step ([#1763](https://github.com/proompteng/lab/issues/1763)) ([6426a85](https://github.com/proompteng/lab/commit/6426a85e0991653a273d8a3b31008f4b5006f949))
* route zig signal workflow to temporal core ([#1601](https://github.com/proompteng/lab/issues/1601)) ([1b42769](https://github.com/proompteng/lab/commit/1b42769d791a1260a1ed65f494afd66535694b87))
* sync cancellation docs and stabilize telemetry tests ([#1604](https://github.com/proompteng/lab/issues/1604)) ([#1661](https://github.com/proompteng/lab/issues/1661)) ([400ae93](https://github.com/proompteng/lab/commit/400ae93858be3a89c0d672e5620ec30440db0a22))
* **temporal-bun-sdk:** fix Zig compilation errors and align platform support ([#1573](https://github.com/proompteng/lab/issues/1573)) ([5c3611f](https://github.com/proompteng/lab/commit/5c3611fcc5cacba5a12325cd90679cd6bdd27510))
* unblock telemetry metrics configuration ([#1471](https://github.com/proompteng/lab/issues/1471)) ([4e0d329](https://github.com/proompteng/lab/commit/4e0d3294e8a38426420579f0e5782172cf93e521))
* wire Zig telemetry configuration ([#1489](https://github.com/proompteng/lab/issues/1489)) ([#1627](https://github.com/proompteng/lab/issues/1627)) ([599f5a9](https://github.com/proompteng/lab/commit/599f5a976fd63460311941af00ed9775c57ce2c2))
* wire zig workflow completion bridge ([#1589](https://github.com/proompteng/lab/issues/1589)) ([#1591](https://github.com/proompteng/lab/issues/1591)) ([e464ce7](https://github.com/proompteng/lab/commit/e464ce73eb775f0df4a13f2a1323fde2e1dcc54f))


### Performance Improvements

* pool Bun bridge byte arrays ([#1461](https://github.com/proompteng/lab/issues/1461)) ([3a241a0](https://github.com/proompteng/lab/commit/3a241a05176fc322eb965b9b13398e9ac1d7b4d4))
