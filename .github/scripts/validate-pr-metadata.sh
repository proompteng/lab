#!/usr/bin/env bash
set -euo pipefail

repository_owner="${GITHUB_REPOSITORY%%/*}"
repository_name="${GITHUB_REPOSITORY#*/}"
case "$GITHUB_EVENT_NAME" in
  pull_request)
    pull_request="$(jq -ce '.pull_request | {number,title,headRefOid:.head.sha}' "$GITHUB_EVENT_PATH")"
    ;;
  merge_group)
    base_branch="$(jq -er '.merge_group.base_ref | ltrimstr("refs/heads/")' "$GITHUB_EVENT_PATH")"
    queue_sha="$(jq -er '.merge_group.head_sha' "$GITHUB_EVENT_PATH")"
    [[ "$queue_sha" == "$GITHUB_SHA" ]]
    # shellcheck disable=SC2016
    queue_entries="$(gh api graphql --paginate --slurp \
      -f owner="$repository_owner" -f repo="$repository_name" -f branch="$base_branch" -f query='
      query ($owner:String!, $repo:String!, $branch:String!, $endCursor:String) {
        repository(owner:$owner, name:$repo) {
          mergeQueue(branch:$branch) {
            entries(first:100, after:$endCursor) {
              nodes { headCommit { oid } pullRequest { number title headRefOid } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }')"
    pull_request="$(jq -ce --arg sha "$queue_sha" '
      [.[] | .data.repository.mergeQueue.entries.nodes[] | select(.headCommit.oid == $sha) | .pullRequest]
      | if length == 1 and .[0] != null then .[0] else error("No unique pull request for the exact merge group") end
    ' <<< "$queue_entries")"
    ;;
  *)
    echo "Unsupported metadata validation event: $GITHUB_EVENT_NAME" >&2
    exit 1
    ;;
esac

number="$(jq -er '.number | select(type == "number" and . > 0)' <<< "$pull_request")"
title="$(jq -er '.title | select(type == "string")' <<< "$pull_request")"
head="$(jq -er '.headRefOid | select(test("^[a-f0-9]{40}$"))' <<< "$pull_request")"
# shellcheck disable=SC2016
commit_pages="$(gh api graphql --paginate --slurp \
  -f owner="$repository_owner" -f repo="$repository_name" -F number="$number" -f query='
  query ($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$number) {
        headRefOid
        commits(first:100, after:$endCursor) {
          totalCount
          nodes { commit { oid message } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }')"
subjects="$(jq -er --arg head "$head" '
  map(.data.repository.pullRequest)
  | if length == 0 or any(.[]; .headRefOid != $head) then error("Pull request head changed during validation") else . end
  | .[0].commits.totalCount as $expected
  | [.[].commits.nodes[].commit]
  | if length != $expected or length == 0 or .[-1].oid != $head then error("Missing commits for the exact pull request head") else . end
  | .[].message | split("\n")[0]
' <<< "$commit_pages")"

valid_subject='^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._/-]+\))?!?: [a-z].+'
failed=0
if [[ "$GITHUB_EVENT_NAME" == merge_group ]]; then
  merge_subject="$(git show -s --format=%s "$queue_sha")"
  if [[ ! "$merge_subject" =~ $valid_subject ]]; then
    printf 'Invalid queued squash subject: %s\n' "$merge_subject" >&2
    failed=1
  fi
fi
if [[ "$title" =~ $valid_subject ]]; then
  printf 'PR title is semantic: %s\n' "$title"
else
  printf 'Invalid PR title: %s\n' "$title" >&2
  failed=1
fi
while IFS= read -r subject; do
  if [[ "$subject" =~ $valid_subject ]]; then
    printf 'Valid commit subject: %s\n' "$subject"
  else
    printf 'Invalid commit subject: %s\n' "$subject" >&2
    failed=1
  fi
done <<< "$subjects"
exit "$failed"
