-- READ ONLY. Later settlement cut: 2026-11-21T08:35:10Z.
-- Historical trading/inference cut is preserved; no new assessment or accounting write.
-- Generation 412430d... binds the same previously verified configured PAPER account.
-- Output includes only aggregate financial figures, timestamps, hashes and sanitized authority state.

BEGIN READ ONLY; SET LOCAL statement_timeout = '12s';
WITH fee AS (
 SELECT fee_date,net_amount_micros,first_observed_at,posted_at,read_evidence->>'observedAt' AS provider_read_at,
        read_evidence->>'sourceCreatedAt' AS source_created_at,read_evidence->>'status' AS read_status,
        jsonb_array_length(cash_match_corrections) AS corrections
 FROM broker_fee_accounting_evidence
 WHERE fee_date = DATE '2026-11-20' AND first_observed_at <= TIMESTAMPTZ '2026-11-21T08:35:10Z' AND account_id = (SELECT account_id FROM authority_generations WHERE generation_hash='412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571')
)
SELECT jsonb_build_object('kind','nov20_fees','count',count(*),'net_micros',COALESCE(sum(net_amount_micros),0)::text,'posted',count(*) FILTER(WHERE posted_at IS NOT NULL),'fees',jsonb_agg(to_jsonb(fee) ORDER BY net_amount_micros)) FROM fee;

COMMIT;

BEGIN READ ONLY; SET LOCAL statement_timeout = '15s';
WITH RECURSIVE lineage AS (
 SELECT g.*,0 AS depth FROM authority_generations g WHERE generation_hash='412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571'
 UNION ALL SELECT g.*,l.depth+1 FROM authority_generations g JOIN lineage l ON g.generation_hash=l.previous_generation_hash WHERE l.depth<3
) SELECT jsonb_build_object('kind','lineage','rows',jsonb_agg(jsonb_build_object('hash',generation_hash,'previous',previous_generation_hash,'maximum',maximum,'authority_version',authority_version,'activated_at',activated_at,'source',activation_source_revision,'image',activation_image_digest,'reconciliation',reconciliation_id,'broker_environment',broker_environment,'plan',research_plan_hash) ORDER BY depth DESC)) FROM lineage;
WITH scope AS(SELECT account_id FROM authority_generations WHERE generation_hash='412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571'),
cuts(label,at_time) AS(VALUES('nov20_open','2026-11-20T00:01:00Z'::timestamptz),('original_cut','2026-11-21T04:47:00Z'::timestamptz),('before_fee','2026-11-21T07:56:15Z'::timestamptz),('after_fee','2026-11-21T07:57:00Z'::timestamptz),('settlement_cut',TIMESTAMPTZ '2026-11-21T08:35:10Z'))
SELECT jsonb_build_object('kind','cash_cuts','rows',jsonb_agg(jsonb_build_object('label',c.label,'observed_at',v.observed_at,'cash_micros',v.cash_micros::text,'equity_micros',v.equity_micros::text,'buying_power_micros',v.buying_power_micros::text) ORDER BY c.at_time)) FROM cuts c CROSS JOIN scope s LEFT JOIN LATERAL(
 SELECT e.observed_at,a.cash_micros,a.equity_micros,a.buying_power_micros FROM account_snapshots a JOIN broker_events e USING(event_id,account_id) WHERE a.account_id=s.account_id AND e.observed_at<=c.at_time ORDER BY e.observed_at DESC LIMIT 1
) v ON true;
WITH scope AS(SELECT account_id FROM authority_generations WHERE generation_hash='412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571')
SELECT jsonb_build_object('kind','fills','since_nov16',count(*),'last_execution',max(e.occurred_at),'last_observed',max(e.observed_at),'executed_since_nov21',count(*) FILTER(WHERE e.occurred_at>='2026-11-21T00:00:00Z'),'observed_after_original_cut',count(*) FILTER(WHERE e.observed_at>'2026-11-21T04:47:00Z')) FROM fills f JOIN broker_events e USING(event_id,account_id) JOIN scope s USING(account_id) WHERE e.occurred_at>='2026-11-16T00:00:00Z' AND e.observed_at <= TIMESTAMPTZ '2026-11-21T08:35:10Z';
WITH scope AS(SELECT account_id FROM authority_generations WHERE generation_hash='412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571'),recent AS(SELECT r.reconciled_at,r.status,r.content_hash,r.reconciliation_id,jsonb_array_length(r.discrepancies) AS discrepancies FROM reconciliations r JOIN scope s USING(account_id) WHERE r.reconciled_at>='2026-11-21T07:55:00Z' AND r.reconciled_at <= TIMESTAMPTZ '2026-11-21T08:35:10Z' ORDER BY r.reconciled_at DESC LIMIT 8)
SELECT jsonb_build_object('kind','recent_reconciliation','rows',jsonb_agg(to_jsonb(recent) ORDER BY reconciled_at)) FROM recent;

COMMIT;

BEGIN READ ONLY; SET LOCAL statement_timeout = '12s';
WITH scope AS(SELECT account_id FROM authority_generations WHERE generation_hash='412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571')
SELECT jsonb_build_object('kind','cash_transition','rows',jsonb_agg(to_jsonb(x) ORDER BY first_observed)) FROM(
 SELECT a.cash_micros::text,a.equity_micros::text,min(e.observed_at) AS first_observed,max(e.observed_at) AS last_observed,count(*) AS observations FROM account_snapshots a JOIN broker_events e USING(event_id,account_id) JOIN scope s USING(account_id) WHERE e.observed_at>='2026-11-21T07:55:00Z' AND e.observed_at<'2026-11-21T08:25:00Z' GROUP BY a.cash_micros,a.equity_micros
) x;
WITH scope AS(SELECT account_id FROM authority_generations WHERE generation_hash='412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571')
SELECT jsonb_build_object('kind','reconciliation_transition','rows',jsonb_agg(to_jsonb(x) ORDER BY first_reconciled)) FROM(
 SELECT status,min(reconciled_at) AS first_reconciled,max(reconciled_at) AS last_reconciled,count(*) AS observations FROM reconciliations r JOIN scope s USING(account_id) WHERE reconciled_at>='2026-11-21T07:55:00Z' AND reconciled_at<'2026-11-21T08:25:00Z' GROUP BY status
) x;
WITH scope AS(SELECT account_id FROM authority_generations WHERE generation_hash='412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571')
SELECT jsonb_build_object('kind','weekly_posted_fees','count',count(*),'net_micros',sum(net_amount_micros)::text,'all_posted',bool_and(posted_at IS NOT NULL)) FROM broker_fee_accounting_evidence f JOIN scope s USING(account_id) WHERE fee_date BETWEEN DATE '2026-11-16' AND DATE '2026-11-20' AND first_observed_at <= TIMESTAMPTZ '2026-11-21T08:35:10Z' AND posted_at <= TIMESTAMPTZ '2026-11-21T08:35:10Z';

COMMIT;

BEGIN READ ONLY; SET LOCAL statement_timeout='12s';
SELECT jsonb_build_object('kind','authority_transition','rows',jsonb_agg(jsonb_build_object('version',authority_version,'captured_at',captured_at,'previous',previous_state,'current',authority_state) ORDER BY authority_version)) FROM operational_safety_authority_transitions WHERE authority_version BETWEEN 1874 AND 1877;
SELECT jsonb_build_object('kind','activation_reconciliation','rows',jsonb_agg(jsonb_build_object('hash',g.generation_hash,'at',r.reconciled_at,'status',r.status,'zero_discrepancies',jsonb_array_length(r.discrepancies)=0,'expected_equals_observed',r.expected_hash=r.observed_hash,'content_hash_matches',r.content_hash=g.reconciliation_content_hash))) FROM authority_generations g JOIN reconciliations r USING(reconciliation_id) WHERE generation_hash IN('6e2cc4028f3c631ca1741768a82ef2e770e9811387b1d17d523a910fafd6039c','412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571');

COMMIT;

BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
WITH latest AS (
 SELECT DISTINCT ON (request_id,provider_stage) * FROM inference_expense_quotes
 WHERE session_date BETWEEN DATE '2026-11-16' AND DATE '2026-11-20' AND created_at<'2026-11-21T04:47:00Z'
 ORDER BY request_id,provider_stage,created_at DESC,quote_hash DESC
),bound AS(
 SELECT q.*,g.account_id AS generation_account_id FROM latest q LEFT JOIN jev_evaluation_requests r USING(request_id) LEFT JOIN authority_generations g ON g.generation_hash=r.authority_generation_hash
)
SELECT jsonb_build_object('kind','fixed_inference','known_pico_usd',sum((payload->'line'->>'estimatedCostPicoUsd')::numeric)::text,
 'known_usd',(sum((payload->'line'->>'estimatedCostPicoUsd')::numeric)/1e12)::text,'quotes',count(*),'account_count',count(DISTINCT account_id),'unbound',count(*) FILTER(WHERE generation_account_id IS NULL),'generation_accounts_match',bool_and(account_id=generation_account_id),'recovered_generation_account_matches',bool_and(account_id=(SELECT account_id FROM authority_generations WHERE generation_hash='412430d571d9ab22e4f4cfcb747334d04306c7f860eec022149e1357be394571'))) FROM bound;
COMMIT;
