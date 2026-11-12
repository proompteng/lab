#!/usr/bin/env bash
set -euo pipefail

proof_dir="${1:?Usage: verify-arc-placement.sh <downloaded-proof-directory>}"
shopt -s nullglob
files=("$proof_dir"/*/arc-complete.json)
if test "${#files[@]}" = 0; then
  echo 'No ARC placement proofs found' >&2
  exit 1
fi

jq -s -e '
  if
    length == 10 and
    ([.[] | select(.role == "build") | .slot] | sort) == [1,2,3,4,5,6,7,8] and
    ([.[] | select(.role == "publication") | .slot] | sort) == [1,2] and
    ([.[].pod] | unique | length) == 10 and
    all(.[];
      (.pod | type) == "string" and (.pod | length) > 0 and
      (.node == "talos-192-168-1-194" or .node == "turin") and
      (.start | type) == "number" and (.end | type) == "number" and
      .start >= 0 and .end >= .start
    ) and
    all(.[] | select(.role == "build");
      .inputBytes == 16777216 and .outputBytes == .inputBytes and
      (.inputSha256 | test("^[a-f0-9]{64}$")) and .inputSha256 == .outputSha256
    ) and
    ([.[].end] | min) - ([.[].start] | max) >= 45
  then
    {
      buildRunners: 8,
      publicationRunners: 2,
      distinctPods: ([.[].pod] | unique | length),
      overlapSeconds: (([.[].end] | min) - ([.[].start] | max)),
      nodes: (group_by(.node) | map({node: .[0].node, runners: length}))
    }
  else error("ARC acceptance requires eight builders and two publishers on distinct eligible Pods, matching output bytes, and 45 seconds of common overlap")
  end
' "${files[@]}"
