#!/usr/bin/env python3
"""Execute a production-real Alpaca broker proof for Torghut."""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, cast

from app.alpaca_client import TorghutAlpacaClient
from app.config import settings
from app.db import SessionLocal
from app.snapshots import snapshot_account_and_positions, sync_order_to_db
from app.trading.firewall import OrderFirewall

TERMINAL_ORDER_STATUSES = frozenset(
    {
        'filled',
        'canceled',
        'cancelled',
        'expired',
        'done_for_day',
        'rejected',
        'stopped',
        'suspended',
    }
)


@dataclass(frozen=True)
class BrokerCredentials:
    label: str
    mode: str
    api_key: str
    secret_key: str
    base_url: str | None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_broker_credentials(mode: str, account_label: str | None) -> BrokerCredentials:
    normalized_mode = mode.strip().lower()
    normalized_label = (account_label or '').strip()
    for lane in settings.trading_accounts:
        lane_mode = str(getattr(lane, 'mode', '') or '').strip().lower()
        lane_label = str(getattr(lane, 'label', '') or '').strip()
        if normalized_label and lane_label != normalized_label:
            continue
        if lane_mode != normalized_mode:
            continue
        api_key = str(getattr(lane, 'api_key', '') or '').strip()
        secret_key = str(getattr(lane, 'secret_key', '') or '').strip()
        if not api_key or not secret_key:
            continue
        base_url = str(getattr(lane, 'base_url', '') or '').strip() or None
        return BrokerCredentials(
            label=lane_label or normalized_mode,
            mode=normalized_mode,
            api_key=api_key,
            secret_key=secret_key,
            base_url=base_url,
        )

    if normalized_mode == 'paper':
        env_key = os.getenv('APCA_PAPER_API_KEY_ID', '').strip()
        env_secret = os.getenv('APCA_PAPER_API_SECRET_KEY', '').strip()
        if env_key and env_secret:
            return BrokerCredentials(
                label=normalized_label or os.getenv('TRADING_PAPER_ACCOUNT_LABEL', '').strip() or 'paper',
                mode='paper',
                api_key=env_key,
                secret_key=env_secret,
                base_url=os.getenv('APCA_PAPER_API_BASE_URL', '').strip() or 'https://paper-api.alpaca.markets',
            )

    if normalized_mode == settings.trading_mode:
        api_key = (settings.apca_api_key_id or '').strip()
        secret_key = (settings.apca_api_secret_key or '').strip()
        if api_key and secret_key:
            return BrokerCredentials(
                label=normalized_label or settings.trading_account_label,
                mode=normalized_mode,
                api_key=api_key,
                secret_key=secret_key,
                base_url=(settings.apca_api_base_url or '').strip() or None,
            )

    raise SystemExit(f'broker_credentials_unavailable:mode={normalized_mode}')


def _load_reference_price(client: TorghutAlpacaClient, symbol: str) -> float:
    bars = client.get_bars(symbols=[symbol], timeframe='1Min', lookback_bars=1)
    symbol_bars = bars.get(symbol) or []
    if not symbol_bars:
        return 1.0
    latest = cast(Mapping[str, Any], symbol_bars[-1])
    for key in ('close', 'c'):
        raw = latest.get(key)
        if raw is None:
            continue
        try:
            price = float(raw)
        except (TypeError, ValueError):
            continue
        if price > 0:
            return price
    return 1.0


def _write_output(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(payload), indent=2, sort_keys=True), encoding='utf-8')


def _proof_payload(
    *,
    credentials: BrokerCredentials,
    client: TorghutAlpacaClient,
    symbol: str,
    qty: float,
    limit_price: float,
    lifecycle: list[dict[str, Any]],
    account: Mapping[str, Any],
    order_id: str | None,
    client_order_id: str,
    verdict: str,
    snapshot_id: str | None,
    persisted_execution_id: str | None,
    persist_db: bool,
) -> dict[str, Any]:
    return {
        'proof_timestamp': _utc_now(),
        'broker_mode': credentials.mode,
        'endpoint_class': client.endpoint_class,
        'account_label': credentials.label,
        'account_number': account.get('account_number'),
        'account_status': account.get('status'),
        'symbol': symbol,
        'qty': qty,
        'limit_price': limit_price,
        'order_id': order_id,
        'client_order_id': client_order_id,
        'persist_db': persist_db,
        'position_snapshot_id': snapshot_id,
        'execution_id': persisted_execution_id,
        'lifecycle': lifecycle,
        'final_status': lifecycle[-1]['status'] if lifecycle else None,
        'verdict': verdict,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('paper', 'live'), default='paper')
    parser.add_argument('--account-label', default=None)
    parser.add_argument('--symbol', default='AAPL')
    parser.add_argument('--qty', type=float, default=1.0)
    parser.add_argument('--limit-price', type=float, default=None)
    parser.add_argument('--limit-discount', type=float, default=0.5)
    parser.add_argument('--poll-seconds', type=float, default=1.0)
    parser.add_argument('--max-wait-seconds', type=float, default=20.0)
    parser.add_argument('--persist-db', action='store_true', default=False)
    parser.add_argument('--output', default=None)
    args = parser.parse_args()

    credentials = _resolve_broker_credentials(args.mode, args.account_label)
    client = TorghutAlpacaClient(
        api_key=credentials.api_key,
        secret_key=credentials.secret_key,
        base_url=credentials.base_url,
        paper=credentials.mode == 'paper',
    )
    firewall = OrderFirewall(client)
    lifecycle: list[dict[str, Any]] = []
    persisted_execution_id: str | None = None
    snapshot_id: str | None = None

    account = cast(Mapping[str, Any], firewall.get_account() or {})
    lifecycle.append(
        {
            'phase': 'account_lookup',
            'status': 'ok',
            'at': _utc_now(),
            'account_status': account.get('status'),
            'account_number': account.get('account_number'),
        }
    )
    asset = firewall.get_asset(args.symbol)
    if asset is None:
        raise SystemExit(f'asset_unavailable:{args.symbol}')
    lifecycle.append(
        {
            'phase': 'asset_lookup',
            'status': 'ok',
            'at': _utc_now(),
            'asset_status': asset.get('status'),
            'tradable': asset.get('tradable'),
        }
    )

    reference_price = args.limit_price or _load_reference_price(client, args.symbol)
    limit_price = round(max(1.0, reference_price * max(0.05, args.limit_discount)), 2)
    client_order_id = f'torghut-broker-proof-{int(time.time())}'
    if args.persist_db:
        with SessionLocal() as session:
            snapshot = snapshot_account_and_positions(
                session,
                client,
                credentials.label,
            )
            snapshot_id = str(snapshot.id)

    submitted = firewall.submit_order(
        symbol=args.symbol,
        side='buy',
        qty=args.qty,
        order_type='limit',
        time_in_force='day',
        limit_price=limit_price,
        extra_params={'client_order_id': client_order_id},
    )
    order_id = str(submitted.get('id') or '').strip() or None
    lifecycle.append(
        {
            'phase': 'submit',
            'status': str(submitted.get('status') or 'submitted'),
            'at': _utc_now(),
            'order_id': order_id,
        }
    )
    if order_id is None:
        raise SystemExit('order_submit_missing_id')

    observed = firewall.get_order(order_id)
    lifecycle.append(
        {
            'phase': 'readback',
            'status': str(observed.get('status') or 'unknown'),
            'at': _utc_now(),
        }
    )

    final_order = observed
    final_status = str(observed.get('status') or '').strip().lower()
    if final_status not in TERMINAL_ORDER_STATUSES:
        firewall.cancel_order(order_id)
        lifecycle.append(
            {
                'phase': 'cancel_requested',
                'status': 'requested',
                'at': _utc_now(),
            }
        )
        deadline = time.monotonic() + max(1.0, args.max_wait_seconds)
        poll_seconds = max(0.1, args.poll_seconds)
        while time.monotonic() < deadline:
            final_order = firewall.get_order(order_id)
            final_status = str(final_order.get('status') or '').strip().lower()
            lifecycle.append(
                {
                    'phase': 'poll',
                    'status': final_status or 'unknown',
                    'at': _utc_now(),
                }
            )
            if final_status in TERMINAL_ORDER_STATUSES:
                break
            time.sleep(poll_seconds)

    if args.persist_db:
        with SessionLocal() as session:
            execution = sync_order_to_db(
                session,
                dict(final_order),
                alpaca_account_label=credentials.label,
                execution_expected_adapter='alpaca',
                execution_actual_adapter='alpaca',
            )
            persisted_execution_id = str(execution.id)

    verdict = (
        'success'
        if str(final_order.get('status') or '').strip().lower() in TERMINAL_ORDER_STATUSES
        else 'failed'
    )
    payload = _proof_payload(
        credentials=credentials,
        client=client,
        symbol=args.symbol,
        qty=args.qty,
        limit_price=limit_price,
        lifecycle=lifecycle,
        account=account,
        order_id=order_id,
        client_order_id=client_order_id,
        verdict=verdict,
        snapshot_id=snapshot_id,
        persisted_execution_id=persisted_execution_id,
        persist_db=args.persist_db,
    )
    if args.output:
        _write_output(Path(args.output), payload)
    print(json.dumps(payload, indent=2, sort_keys=True))
    if verdict != 'success':
        raise SystemExit('broker_proof_failed')


if __name__ == '__main__':
    main()
