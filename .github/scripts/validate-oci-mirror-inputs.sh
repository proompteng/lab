#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_REPOSITORY:?SOURCE_REPOSITORY is required}"
: "${SOURCE_DIGEST:?SOURCE_DIGEST is required}"
: "${TARGET_REPOSITORY:?TARGET_REPOSITORY is required}"
: "${TARGET_TAG:?TARGET_TAG is required}"

repository_pattern='^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$'
digest_pattern='^sha256:[0-9a-f]{64}$'
tag_pattern='^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$'

[[ "$SOURCE_REPOSITORY" =~ $repository_pattern ]]
[[ "$TARGET_REPOSITORY" =~ $repository_pattern ]]
[[ "$SOURCE_DIGEST" =~ $digest_pattern ]]
[[ "$TARGET_TAG" =~ $tag_pattern ]]
