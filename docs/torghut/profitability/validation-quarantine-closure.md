# Infrastructure-Validation Quarantine Closure

Status: normative operator-action contract for the narrow unresolved-paper-IOC case in profitability roadmap Slice 5.

## Decision

Torghut may close an unresolved submit quarantine without asserting broker rejection only when the receipt is an
unlinked, non-promotable, Alpaca-paper `control_plane_validation` order with `time_in_force=ioc`. The terminal outcome
is `validation_quarantine_closed`, the source is `operator_confirmation`, and the evidence keeps
`order_existence_resolution=unresolved`.

This terminal says only that the receipt can no longer create future exposure and the paper account is freshly flat. It
does not say that Alpaca rejected the order, that the order never existed, or that its economics are admissible for
profitability, trials, promotion, or accounting parity.

Alpaca warns that a timed-out submit may have reached the market and must not be resent or marked canceled before
confirmation. Torghut preserves that ambiguity and never retries the client order ID. Alpaca also defines IOC as an
order whose unfilled portion is canceled immediately, so an old IOC cannot remain resting. The operator still must
prove the current account has zero open orders and zero positions. Sources:
[Working with orders](https://docs.alpaca.markets/us/v1.1/docs/working-with-orders),
[Get order by client order ID](https://docs.alpaca.markets/us/reference/getorderbyclientorderid), and
[Get all orders](https://docs.alpaca.markets/us/v1.1/reference/getallorders-1).

## Exact Eligibility Boundary

All conditions are mandatory in application code and PostgreSQL:

- broker route `alpaca`, endpoint fingerprint for `https://paper-api.alpaca.markets`;
- operation `submit_order`, risk class `risk_neutral`, purpose `control_plane_validation`;
- no linked decision-submission claim;
- sealed validation permit says `account_mode=paper`, `promotable=false`, and
  `evidence_tag=non_promotable_validation`;
- sealed broker request is `time_in_force=ioc`;
- broker I/O started at least one minute earlier;
- latest recovery is a complete `not_found` observation projected as `expired`, with automatic resubmission false;
- caller supplies the exact receipt ID and exact sealed intent SHA-256;
- fresh exact client-order lookup is absent;
- a bounded all-status history page is complete and contains no matching client order ID;
- broker account identity is exact and active, with no account/trading/transfer block;
- the entire account has zero open orders and zero positions.

Ordinary strategy submits, live endpoints, linked claims, GTC/DAY orders, partial evidence, a found order, a full
500-row history page, any open order, or any position fail closed. The workflow exposes no submit, cancel, replace, or
close method.

## State And Concurrency

The append-only receipt stream remains the only authority:

`broker_io(expired) -> settled(validation_quarantine_closed)`

The operator transition locks the receipt identity, requires a contiguous next sequence, rejects a previously settled
receipt, and records its own writer generation. Concurrent recovery either commits first and causes the operator's
prior-evidence hash to fail, or observes the terminal state and stops. No recovery row, approval queue, parallel status
table, or mutable override is introduced.

PostgreSQL independently checks the receipt class, paper endpoint, IOC policy, prior recovery evidence hash, account
snapshot claims, zero counts, non-promotable marker, operator identity, and evidence freshness. The settlement envelope
is hashed and append-only. Downgrade refuses while this outcome exists.

## Operator Procedure

Run from the exact deployed Torghut image. Dry-run first:

```bash
python -m app.trading.infrastructure_validation_quarantine \
  --receipt-id "$RECEIPT_ID" \
  --expected-intent-sha256 "$INTENT_SHA256" \
  --operator-id "$OPERATOR_ID"
```

Apply only when the dry-run returns the expected receipt, intent hash, and evidence hash:

```bash
python -m app.trading.infrastructure_validation_quarantine \
  --receipt-id "$RECEIPT_ID" \
  --expected-intent-sha256 "$INTENT_SHA256" \
  --operator-id "$OPERATOR_ID" \
  --apply \
  --confirm CLOSE_PAPER_IOC_VALIDATION_QUARANTINE
```

If Alpaca Support supplied a reference, add `--support-confirmation-reference`; it is recorded but never used to turn
the outcome into broker rejection.

After each apply, read the broker account again, query the exact receipt history through CNPG, and verify
`/trading/status` reports no unresolved submit receipt. A fresh controlled validation lifecycle and normal strategy
entry proof remain separate gates.

## Rollback

Remove the CLI/operator transition through a forward application change. Existing terminal evidence remains immutable.
Do not rewrite it to `rejected`, delete it, or re-open the client order ID. If the terminal is later contradicted by
broker activity, append a correction/incident record and keep entry blocked until the account and independent economic
ledger reconcile.
