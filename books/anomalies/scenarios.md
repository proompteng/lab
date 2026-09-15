# Synthetic Anomaly Scenarios

The notebook seeds four repeatable anomaly templates inside `generateQboJournalEntries`. Each one maps to a finance playbook once the Isolation Forest score crosses the working threshold (`score ≥ 0.62`).

## 1. Doc Number Reuse (Scenario 0)

- **Generator trigger**: Replays the prior sequence number so two consecutive journals carry the same suffix.
- **Feature cues**: `doc_sequence_gap = -1` while balance-related fields stay normal; `doc_number_length` and `line_count` mirror the baseline population.
- **Operational move**: During close, have the controller confirm whether the duplicate replaced a voided entry or if the wrong template was re-used; reconcile attachments before approving.

## 2. Sequence Jump (Scenario 1)

- **Generator trigger**: Skips three sequence numbers to mimic missing paperwork or back-dated inserts.
- **Feature cues**: `doc_sequence_gap = +3`, minor shifts in `day_of_month`, but totals remain balanced.
- **Operational move**: Investigate the surrounding documents in QBO, escalate to the preparer for missing approvals, and reconcile to the subledger before close.

## 3. FX Imbalance (Scenario 2)

- **Generator trigger**: Forces a non-USD currency and suppresses the credit leg, leaving the entry out of balance.
- **Feature cues**: `foreign_currency_flag = 1`, `imbalance` spikes, `total_debit` drifts beyond the typical range, and line dispersion (`std_line_amount`) widens.
- **Operational move**: Route to treasury for an exchange-rate check, confirm clearing-account mappings, and require evidence that the counter-entry posted in the source system.

## 4. Manual Reclass Spike (Scenario 3)

- **Generator trigger**: Marks the journal as an adjustment, injects a large `Deferred Revenue` credit line, and inflates memo text.
- **Feature cues**: `line_count` climbs, `avg_line_amount` and `std_line_amount` jump, `memo_length` stretches, and `imbalance` can surface if the extra leg is mis-sized.
- **Operational move**: Collect approvals from revenue ops, validate support (contracts, schedules), and confirm the reclassification reverses or amortizes according to policy.

## Production handoff checklist

- Set the score cutoff per team tolerance (start with 0.62, dial down if precision@25 is acceptable).
- Export Isolation Forest hits with `doc_number`, `txnDate`, `memo`, and key feature deltas so reviewers have context.
- Track reviewer outcomes to retrain the detector—especially when introducing new FX pairs or adjustment types.
