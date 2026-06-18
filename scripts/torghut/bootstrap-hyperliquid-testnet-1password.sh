#!/usr/bin/env bash
set -euo pipefail

VAULT="${HYPERLIQUID_TESTNET_1PASSWORD_VAULT:-infra}"
ITEM="${HYPERLIQUID_TESTNET_1PASSWORD_ITEM:-hyperliquid-testnet}"

usage() {
  cat <<EOF
Usage:
  $0 status
  $0 check
  $0 create
  $0 reconcile

Creates or verifies the 1Password item consumed by External Secrets for the
Torghut Hyperliquid testnet runtime.

Required 1Password fields:
  - account-address
  - api-wallet-private-key

The account address must be the main Hyperliquid testnet account address. The
private key must belong to an API/agent wallet already authorized for that
account in Hyperliquid testnet.
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_op_session() {
  require_command op
  if ! op whoami >/dev/null 2>&1; then
    echo "1Password CLI is not signed in. Run: op signin" >&2
    exit 1
  fi
}

check_item() {
  require_op_session
  op item get "${ITEM}" --vault "${VAULT}" --format json >/dev/null
  op read --no-newline "op://${VAULT}/${ITEM}/account-address" >/dev/null
  op read --no-newline "op://${VAULT}/${ITEM}/api-wallet-private-key" >/dev/null
  echo "1Password item is present: op://${VAULT}/${ITEM}"
}

status() {
  local ready=true

  if command -v op >/dev/null 2>&1 && op whoami >/dev/null 2>&1; then
    echo "1Password CLI: signed in"
    if op item get "${ITEM}" --vault "${VAULT}" --format json >/dev/null 2>&1; then
      echo "1Password item: present at op://${VAULT}/${ITEM}"
    else
      echo "1Password item: missing at op://${VAULT}/${ITEM}"
      ready=false
    fi

    for field in account-address api-wallet-private-key; do
      if op read --no-newline "op://${VAULT}/${ITEM}/${field}" >/dev/null 2>&1; then
        echo "1Password field ${field}: present"
      else
        echo "1Password field ${field}: missing"
        ready=false
      fi
    done
  else
    echo "1Password CLI: not signed in"
    ready=false
  fi

  if command -v kubectl >/dev/null 2>&1; then
    local external_secret_status=""
    local external_secret_reason=""
    local external_secret_message=""

    if kubectl -n torghut get externalsecret torghut-hyperliquid-testnet >/dev/null 2>&1; then
      external_secret_status="$(
        kubectl -n torghut get externalsecret torghut-hyperliquid-testnet \
          -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.status}{end}' 2>/dev/null || true
      )"
      external_secret_reason="$(
        kubectl -n torghut get externalsecret torghut-hyperliquid-testnet \
          -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.reason}{end}' 2>/dev/null || true
      )"
      external_secret_message="$(
        kubectl -n torghut get externalsecret torghut-hyperliquid-testnet \
          -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.message}{end}' 2>/dev/null || true
      )"

      echo "ExternalSecret Ready: ${external_secret_status:-Unknown}"
      if [[ -n "${external_secret_reason}" ]]; then
        echo "ExternalSecret reason: ${external_secret_reason}"
      fi
      if [[ -n "${external_secret_message}" ]]; then
        echo "ExternalSecret message: ${external_secret_message}"
      fi

      if [[ "${external_secret_status}" != "True" ]]; then
        ready=false
      fi
    else
      echo "ExternalSecret: missing in namespace torghut"
      ready=false
    fi

    if kubectl -n torghut get secret torghut-hyperliquid-testnet >/dev/null 2>&1; then
      echo "Kubernetes Secret: present"
    else
      echo "Kubernetes Secret: missing"
      ready=false
    fi
  else
    echo "kubectl: missing"
    ready=false
  fi

  if [[ "${ready}" == "true" ]]; then
    echo "Hyperliquid testnet secret bootstrap: ready"
    return 0
  fi

  echo "Hyperliquid testnet secret bootstrap: not ready"
  return 1
}

create_item() {
  require_op_session
  require_command python3

  if op item get "${ITEM}" --vault "${VAULT}" --format json >/dev/null 2>&1; then
    echo "1Password item already exists: op://${VAULT}/${ITEM}" >&2
    echo "Run '$0 check' to validate the required fields." >&2
    exit 1
  fi

  tmp="$(mktemp)"
  chmod 600 "${tmp}"
  trap 'rm -f "${tmp}"' EXIT

  python3 - "${tmp}" "${ITEM}" <<'PY'
import getpass
import json
import re
import sys

path = sys.argv[1]
title = sys.argv[2]

account_address = input("Hyperliquid testnet main account address: ").strip()
api_wallet_private_key = getpass.getpass("Authorized API wallet private key: ").strip()

if not re.fullmatch(r"0x[a-fA-F0-9]{40}", account_address):
    raise SystemExit("account address must be a 42-character 0x-prefixed address")
if not re.fullmatch(r"0x[a-fA-F0-9]{64}", api_wallet_private_key):
    raise SystemExit("API wallet private key must be a 66-character 0x-prefixed key")

item = {
    "title": title,
    "category": "LOGIN",
    "fields": [
        {
            "id": "username",
            "type": "STRING",
            "purpose": "USERNAME",
            "label": "username",
            "value": account_address,
        },
        {
            "id": "password",
            "type": "CONCEALED",
            "purpose": "PASSWORD",
            "label": "password",
            "value": api_wallet_private_key,
        },
        {
            "id": "account-address",
            "type": "STRING",
            "label": "account-address",
            "value": account_address,
        },
        {
            "id": "api-wallet-private-key",
            "type": "CONCEALED",
            "label": "api-wallet-private-key",
            "value": api_wallet_private_key,
        },
        {
            "id": "notesPlain",
            "type": "STRING",
            "purpose": "NOTES",
            "label": "notesPlain",
            "value": (
                "Torghut Hyperliquid testnet runtime credentials. "
                "The password/custom api-wallet-private-key field is an authorized "
                "Hyperliquid API/agent wallet private key, not a main wallet key."
            ),
        },
    ],
}

with open(path, "w", encoding="utf-8") as output:
    json.dump(item, output)
    output.write("\n")
PY

  op item create --vault "${VAULT}" --template "${tmp}" >/dev/null
  check_item
}

reconcile_external_secret() {
  check_item
  require_command kubectl
  kubectl -n torghut annotate externalsecret torghut-hyperliquid-testnet \
    "force-sync=$(date +%s)" \
    --overwrite
  if ! kubectl -n torghut wait --for=condition=Ready externalsecret/torghut-hyperliquid-testnet --timeout=120s; then
    echo "ExternalSecret did not become Ready after reconcile." >&2
    status || true
    exit 1
  fi
  status
}

case "${1:-}" in
  status)
    status
    ;;
  check)
    check_item
    ;;
  create)
    create_item
    ;;
  reconcile)
    reconcile_external_secret
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
