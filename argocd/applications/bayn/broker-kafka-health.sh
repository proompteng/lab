#!/usr/bin/bash
set -euo pipefail

port="${RESTATE_METRICS_PORT:-9464}"
if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
  echo 'broker ingress health: invalid metrics port' >&2
  exit 1
fi

# The pinned adapter holds one HTTP/2 ingestion request per assigned partition, even on a quiet topic.
# A terminal session can leave its Kafka assignment and TCP connection alive after that request ends.
exec 3<>"/dev/tcp/127.0.0.1/$port"
printf 'GET /metrics HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3
exec awk '
  { sub(/\r$/, "") }
  NR == 1 {
    if ($0 !~ /^HTTP\/1\.[01] 200([[:space:]]|$)/) invalid = 1
    next
  }
  !body {
    if ($0 == "") body = 1
    next
  }
  $0 == "# TYPE kafka_consumer_coordinator_assigned_partitions gauge" { assignmentType = 1 }
  $0 == "# TYPE vertx_http_client_active_requests gauge" { requestType = 1 }
  /^kafka_consumer_coordinator_assigned_partitions(\{|[[:space:]])/ {
    if ($1 !~ /^kafka_consumer_coordinator_assigned_partitions(\{[^{}]*\})?$/ ||
        NF != 2 || $2 !~ /^[0-9]+([.]0+)?$/ || assignments[$1]++) invalid = 1
    assigned += $2
    assignmentSamples++
  }
  /^vertx_http_client_active_requests\{/ && /[{,]method="POST"[,}]/ {
    if ($1 !~ /^vertx_http_client_active_requests\{[^{}]*\}$/ ||
        NF != 2 || $2 !~ /^[0-9]+([.]0+)?$/ || requests[$1]++) invalid = 1
    active += $2
    requestSamples++
  }
  END {
    if (!body || invalid || !assignmentType || !assignmentSamples) {
      print "broker ingress health: missing or malformed ingestion metrics" > "/dev/stderr"
      exit 1
    }
    if (assigned > 0 && (!requestType || !requestSamples || active < assigned)) {
      print "broker ingress health: assigned partitions lack active ingestion streams" > "/dev/stderr"
      exit 1
    }
  }
' <&3
