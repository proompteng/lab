-- Bayn PAPER execution-price diagnostics for the fixed November 16-20, 2026 cut.
-- Source inspected: 51f39ce495d2230abb3649bac4d86a22db28db04.
-- Runtime source at capture: 22424d95916aeb732f8dfd8229c4bf4057532f28.
-- Run with: psql -X -v ON_ERROR_STOP=1 -U postgres -d bayn -f <this-file>
-- Use the authorized read-only diagnostic route and a verified read replica.
-- No credentials, account identifiers, DDL or write statements are included.
-- The fixed cut was verified to contain exactly one account across transactions,
-- intents and fills, matching the configured PAPER account. These queries rely
-- on that verified single-account scope. Add an explicit account predicate before
-- reusing them with a multi-account dataset.
--
-- Positive signed shortfall means a worse fill price than the named benchmark;
-- negative means a favorable price. USD and bps use exact PostgreSQL numeric
-- arithmetic and actual filled quantities. Quantity and price atoms have 1e9 scale.
-- Prices read from retained JSON remain IEX exchange-only observations, not NBBO.
--
-- Entry results condition on executed entries. Each of the 169 entry cycles in
-- this fixed cut is one flat-to-flat episode; 413 entry fills are retained.
-- First-fill intervals are timestamp differences, including resting/transport
-- time, not submission latency or clock-synchronized end-to-end trace durations.
-- PostgreSQL parses quote instants at microsecond precision. Ordering also uses
-- the retained topic, partition and offset. All selected quotes are present in
-- the native retained decision rows; this query does not replay their source
-- tokens, reproduce all financial hashes, or independently reread TigerBeetle.
--
-- Exit targets are compared with the original profit limit; stops with their
-- original trigger. Those are plan-level benchmarks, not arrival-price quotes.
-- Application closes use the exact closing document's orderedIntentIds; a
-- strategy hash alone is insufficient because replans can reuse it.
-- Relevant native order histories had zero conflicting (order_type,parent) roles
-- when checked at the evidence cut. The LIMIT 1 lookup relies on that verified
-- property of this fixed cohort and is not a general ambiguous-order resolver.
-- Three OCO parent limit fills are targets only with matching original entry
-- decision identity and protection levels. Mixed-exit episode counts overlap.
-- Four November 17 AMZN application-close fills have no retained quote and remain
-- included in fills/episodes but excluded from priced totals. The difference
-- between fills and priced_fills exposes those four missing benchmarks.
--
-- These are descriptive PAPER diagnostics, not complete implementation shortfall:
-- missing opportunities, market impact, adverse selection, provider simulation
-- realism, external clock error and full operating costs remain unresolved.
-- Keep original time bounds. Do not turn this cohort into prospective evidence.
--
-- Query 1 output columns:
-- session_date, episodes, entry_fills, original_shortfall_usd,
-- refreshed_shortfall_usd, original_shortfall_bps, refreshed_shortfall_bps,
-- original_quote_to_first_fill_p50/p95, refreshed_quote_to_first_fill_p50/p95,
-- decision_to_first_fill_p50/p95.

BEGIN READ ONLY; SET LOCAL statement_timeout='20s';
WITH t AS MATERIALIZED(
 SELECT a.*,i.cycle_id FROM accounting_transactions a JOIN intents i USING(intent_id)
 WHERE occurred_at>='2026-11-16T00:00:00Z' AND occurred_at<'2026-11-21T01:07:10Z'
), d AS MATERIALIZED(
 SELECT s.cycle_id,s.created_at,
 s.document->'strategyDecision'->'selectedSymbols'->>0 AS symbol,
 s.document->'targetPlan'->'intentTargets'->0->>'side' AS entry_side,
 s.document->'strategyDecision'->'evidence'->'observation'->'rows'->'quotes' AS original_quotes,
 s.document->'executionMarketDataRows'->'quotes' AS pricing_quotes
 FROM autonomous_cycle_shadow_decisions s WHERE s.cycle_id IN(SELECT DISTINCT cycle_id FROM t)
), q AS (
 SELECT d.cycle_id,d.symbol,d.entry_side,d.created_at,oq.value AS original_quote,pq.value AS pricing_quote
 FROM d CROSS JOIN LATERAL(SELECT value FROM jsonb_array_elements(original_quotes) WHERE value->>'symbol'=d.symbol ORDER BY (value->>'event_at')::timestamptz DESC,value->>'source_topic' DESC,(value->>'source_partition')::integer DESC,(value->>'source_offset')::numeric DESC LIMIT 1)oq
 CROSS JOIN LATERAL(SELECT value FROM jsonb_array_elements(pricing_quotes) WHERE value->>'symbol'=d.symbol ORDER BY (value->>'event_at')::timestamptz DESC,value->>'source_topic' DESC,(value->>'source_partition')::integer DESC,(value->>'source_offset')::numeric DESC LIMIT 1)pq
), priced AS (
 SELECT t.*,q.created_at AS decision_created_at,(q.original_quote->>'event_at')::timestamptz AS original_quote_at,(q.pricing_quote->>'event_at')::timestamptz AS pricing_quote_at,
 CASE WHEN t.side='BUY' THEN 1 ELSE -1 END AS side_sign,
 (CASE WHEN t.side='BUY' THEN q.original_quote->>'ask_price' ELSE q.original_quote->>'bid_price' END)::numeric AS original_price,
 (CASE WHEN t.side='BUY' THEN q.pricing_quote->>'ask_price' ELSE q.pricing_quote->>'bid_price' END)::numeric AS pricing_price
 FROM t JOIN q USING(cycle_id,symbol) WHERE t.side=q.entry_side
), episode AS (
 SELECT cycle_id,min(occurred_at) AS first_fill,count(*) AS fills,
 sum(side_sign*quantity_atoms/1e9*(price_atoms/1e9-original_price)) AS source_shortfall_usd,
 sum(side_sign*quantity_atoms/1e9*(price_atoms/1e9-pricing_price)) AS pricing_shortfall_usd,
 sum(quantity_atoms/1e9*original_price) AS source_notional,
 sum(quantity_atoms/1e9*pricing_price) AS pricing_notional,
 min(occurred_at)-min(original_quote_at) AS source_to_fill,
 min(occurred_at)-min(pricing_quote_at) AS pricing_to_fill,
 min(occurred_at)-min(decision_created_at) AS decision_to_fill
 FROM priced GROUP BY cycle_id
)
SELECT (first_fill AT TIME ZONE 'America/New_York')::date,count(*),sum(fills),
round(sum(source_shortfall_usd),2),round(sum(pricing_shortfall_usd),2),
round(sum(source_shortfall_usd)/sum(source_notional)*1e4,6),
round(sum(pricing_shortfall_usd)/sum(pricing_notional)*1e4,6),
percentile_disc(.5)within group(order by source_to_fill),percentile_disc(.95)within group(order by source_to_fill),
percentile_disc(.5)within group(order by pricing_to_fill),percentile_disc(.95)within group(order by pricing_to_fill),
percentile_disc(.5)within group(order by decision_to_fill),percentile_disc(.95)within group(order by decision_to_fill)
FROM episode GROUP BY 1 ORDER BY 1;
COMMIT;

-- Query 2: exit cohorts. priced_fills exposes missing benchmark coverage.
BEGIN READ ONLY; SET LOCAL statement_timeout='25s';
WITH tx AS MATERIALIZED (
 SELECT a.*,i.cycle_id,i.protection FROM accounting_transactions a JOIN intents i USING(intent_id)
 WHERE a.occurred_at>='2026-11-16T00:00:00Z' AND a.occurred_at<'2026-11-21T01:07:10Z'
), entry AS MATERIALIZED (
 SELECT s.cycle_id,s.decision_hash,s.document->'targetPlan'->'intentTargets'->0->>'side' AS entry_side,
 s.document->'strategyDecision'->'exitPolicy'->'plans' AS plans
 FROM autonomous_cycle_shadow_decisions s WHERE s.cycle_id IN(SELECT DISTINCT cycle_id FROM tx)
), closing AS MATERIALIZED (
 SELECT t.*,e.decision_hash AS entry_hash,e.plans->t.symbol->'levels' AS levels,o.order_type,
 o.parent_broker_order_id IS NOT NULL AS native_child
 FROM tx t JOIN entry e USING(cycle_id) JOIN fills f ON f.event_id=t.broker_event_id
 LEFT JOIN LATERAL(SELECT order_type,parent_broker_order_id FROM orders
 WHERE broker_order_id=f.broker_order_id AND account_id=f.account_id LIMIT 1)o ON true
 WHERE t.side<>e.entry_side
), docs AS MATERIALIZED (
 SELECT document->'document' AS doc FROM autonomous_cycle_paper_closures WHERE cycle_id IN(SELECT DISTINCT cycle_id FROM closing)
 UNION ALL SELECT document->'document' FROM autonomous_cycle_paper_close_replans WHERE cycle_id IN(SELECT DISTINCT cycle_id FROM closing)
), quotes AS MATERIALIZED (
 SELECT id.value AS intent_id,COALESCE(doc->'executionMarketDataRows'->'quotes',doc->'decisionMarketDataRows'->'quotes') AS rows
 FROM docs CROSS JOIN LATERAL jsonb_array_elements_text(doc->'orderedIntentIds') id
), classified AS (
 SELECT c.*,
 CASE WHEN c.order_type='LIMIT' AND (c.native_child OR
 (c.protection->>'_tag'='Oco' AND c.protection->>'entryDecisionHash'=c.entry_hash
 AND c.protection->>'stopPriceMicros'=c.levels->>'stopPriceMicros'
 AND c.protection->>'stopLimitPriceMicros'=c.levels->>'stopLimitPriceMicros'
 AND c.protection->>'profitLimitPriceMicros'=c.levels->>'profitLimitPriceMicros')) THEN 'NATIVE_TARGET_VS_LIMIT'
 WHEN c.order_type='STOP_LIMIT' AND c.native_child THEN 'NATIVE_STOP_VS_TRIGGER'
 ELSE 'APPLICATION_VS_IEX' END AS benchmark_kind,
 q.value AS quote
 FROM closing c LEFT JOIN quotes p USING(intent_id)
 LEFT JOIN LATERAL(SELECT value FROM jsonb_array_elements(p.rows) WHERE value->>'symbol'=c.symbol
 ORDER BY (value->>'event_at')::timestamptz DESC,value->>'source_topic' DESC,
 (value->>'source_partition')::integer DESC,(value->>'source_offset')::numeric DESC LIMIT 1)q ON true
), priced AS (
 SELECT *,CASE benchmark_kind WHEN 'NATIVE_TARGET_VS_LIMIT' THEN (levels->>'profitLimitPriceMicros')::numeric/1e6
 WHEN 'NATIVE_STOP_VS_TRIGGER' THEN (levels->>'stopPriceMicros')::numeric/1e6
 ELSE (CASE WHEN side='BUY' THEN quote->>'ask_price' ELSE quote->>'bid_price' END)::numeric END AS reference_price
 FROM classified
)
SELECT (occurred_at AT TIME ZONE 'America/New_York')::date,benchmark_kind,count(*) AS fills,
 count(DISTINCT cycle_id) AS episodes,count(reference_price) AS priced_fills,
 round(sum((CASE WHEN side='BUY' THEN 1 ELSE -1 END)*quantity_atoms/1e9*(price_atoms/1e9-reference_price)),2) AS signed_shortfall_usd,
 round(sum((CASE WHEN side='BUY' THEN 1 ELSE -1 END)*quantity_atoms/1e9*(price_atoms/1e9-reference_price))/sum(quantity_atoms/1e9*reference_price)*1e4,6) AS signed_shortfall_bps,
 percentile_disc(.5)within group(order by occurred_at-(quote->>'event_at')::timestamptz) FILTER(WHERE benchmark_kind='APPLICATION_VS_IEX') AS quote_fill_p50,
 percentile_disc(.95)within group(order by occurred_at-(quote->>'event_at')::timestamptz) FILTER(WHERE benchmark_kind='APPLICATION_VS_IEX') AS quote_fill_p95
FROM priced GROUP BY 1,2 ORDER BY 1,2;
COMMIT;
