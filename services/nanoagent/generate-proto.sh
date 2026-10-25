#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
nanoagent_proto_tools=$(mktemp -d)
trap 'rm -rf "$nanoagent_proto_tools"' EXIT
GOBIN="$nanoagent_proto_tools" GOWORK=off go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
GOBIN="$nanoagent_proto_tools" GOWORK=off go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.6.2
PATH="$nanoagent_proto_tools:$PATH" buf generate ../tengri/proto \
  --template buf.gen.yaml \
  --path ../tengri/proto/proompteng/runtime/guest/v1/nanoagent.proto
