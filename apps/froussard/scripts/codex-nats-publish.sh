#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: codex-nats-publish --kind <status|log> [options]

Options:
  --kind <value>        Required kind for the event.
  --content <text>      Publish a single event with the provided content.
  --log-file <path>     Tail a log file and publish each line as an event.
  --channel <value>     Channel name for run-specific events (default: run).
  --publish-general     Also publish each event to argo.workflow.general.<kind>.
  --status <value>      Optional status value for status events.
  --exit-code <value>   Optional exit code for status events.
  -h, --help            Show this help text.

Environment:
  NATS_URL              NATS server URL.
  NATS_CREDS            Optional credentials content.
  NATS_CREDS_FILE       Optional credentials file path.
  NATS_SUBJECT_PREFIX   Subject prefix (default: argo.workflow).
  WORKFLOW_NAME         Argo workflow name.
  WORKFLOW_UID          Argo workflow uid.
  WORKFLOW_NAMESPACE    Argo workflow namespace.
  WORKFLOW_STAGE        Optional workflow stage.
  WORKFLOW_STEP         Optional workflow step (e.g. pod name).
  AGENT_ID              Agent identifier.
USAGE
}

kind=''
content=''
log_file=''
channel='run'
publish_general=false
status=''
exit_code=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)
      kind=${2:-}
      shift 2
      ;;
    --content)
      content=${2:-}
      shift 2
      ;;
    --log-file)
      log_file=${2:-}
      shift 2
      ;;
    --channel)
      channel=${2:-}
      shift 2
      ;;
    --publish-general)
      publish_general=true
      shift
      ;;
    --status)
      status=${2:-}
      shift 2
      ;;
    --exit-code)
      exit_code=${2:-}
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$kind" ]]; then
  echo "Missing required --kind" >&2
  usage >&2
  exit 1
fi

if [[ -z "${NATS_URL:-}" ]]; then
  exit 0
fi

if ! command -v nats >/dev/null 2>&1; then
  echo "nats CLI not found; skipping publish" >&2
  exit 0
fi

workflow_namespace=${WORKFLOW_NAMESPACE:-argo-workflows}
workflow_name=${WORKFLOW_NAME:-unknown}
workflow_uid=${WORKFLOW_UID:-unknown}
workflow_stage=${WORKFLOW_STAGE:-}
workflow_step=${WORKFLOW_STEP:-${STEP_ID:-}}
agent_id=${AGENT_ID:-unknown}
subject_prefix=${NATS_SUBJECT_PREFIX:-argo.workflow}

creds_file=''
creds_tmp=''
if [[ -n "${NATS_CREDS_FILE:-}" ]]; then
  creds_file=$NATS_CREDS_FILE
elif [[ -n "${NATS_CREDS:-}" ]]; then
  creds_tmp=$(mktemp)
  printf '%s' "$NATS_CREDS" > "$creds_tmp"
  creds_file=$creds_tmp
fi

cleanup_creds() {
  if [[ -n "$creds_tmp" ]]; then
    rm -f "$creds_tmp"
  fi
}
trap cleanup_creds EXIT

nats_args=(--server "$NATS_URL")
if [[ -n "$creds_file" ]]; then
  nats_args+=(--creds "$creds_file")
fi

run_subject="${subject_prefix}.${workflow_namespace}.${workflow_name}.${workflow_uid}.agent.${agent_id}.${kind}"
general_subject="${subject_prefix}.general.${kind}"

build_payload() {
  local message_id=$1
  local sent_at=$2
  local content_value=$3
  local channel_value=$4

  jq -cn \
    --arg message_id "$message_id" \
    --arg sent_at "$sent_at" \
    --arg kind "$kind" \
    --arg workflow_uid "$workflow_uid" \
    --arg workflow_name "$workflow_name" \
    --arg workflow_namespace "$workflow_namespace" \
    --arg workflow_stage "$workflow_stage" \
    --arg workflow_step "$workflow_step" \
    --arg agent_id "$agent_id" \
    --arg channel "$channel_value" \
    --arg content "$content_value" \
    --arg status "$status" \
    --arg exit_code "$exit_code" \
    '{
      message_id: $message_id,
      sent_at: $sent_at,
      kind: $kind,
      workflow_uid: $workflow_uid,
      workflow_name: $workflow_name,
      workflow_namespace: $workflow_namespace,
      agent_id: $agent_id,
      channel: $channel,
      content: $content
    }
    + ( ($workflow_stage | length) > 0 ? {workflow_stage: $workflow_stage} : {} )
    + ( ($workflow_step | length) > 0 ? {workflow_step: $workflow_step} : {} )
    + ( ($status | length) > 0 ? {status: $status} : {} )
    + ( ($exit_code | length) > 0 ? {exit_code: ($exit_code | tonumber)} : {} )'
}

publish_payload() {
  local subject=$1
  local payload=$2

  if ! nats pub "$subject" "${nats_args[@]}" -H 'content-type: application/json' "$payload" >/dev/null 2>&1; then
    echo "Failed to publish to $subject" >&2
  fi
}

publish_event() {
  local line=$1
  if [[ -z "$line" ]]; then
    return
  fi

  local message_id
  message_id=$(cat /proc/sys/kernel/random/uuid)
  local sent_at
  sent_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

  local run_payload
  run_payload=$(build_payload "$message_id" "$sent_at" "$line" "$channel")
  publish_payload "$run_subject" "$run_payload"

  if [[ "$publish_general" == true ]]; then
    local general_payload
    general_payload=$(build_payload "$message_id" "$sent_at" "$line" 'general')
    publish_payload "$general_subject" "$general_payload"
  fi
}

if [[ -n "$log_file" ]]; then
  tail -n +1 -F "$log_file" | while IFS= read -r line; do
    publish_event "$line"
  done
  exit 0
fi

if [[ -n "$content" ]]; then
  publish_event "$content"
  exit 0
fi

while IFS= read -r line; do
  publish_event "$line"
done
