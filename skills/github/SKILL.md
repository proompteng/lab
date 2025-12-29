---
name: github
description: GitHub operations with gh and git: create/update/review PRs, address review comments, manage issues, check/rerun workflows, and merge PRs. Use when the user asks to work on GitHub PRs or issues, respond/resolve review threads, inspect CI runs, or perform merges/releases.
---

# GitHub

## Quick start

- Read `AGENTS.md` and `CLAUDE.md` in the repo root for repo-specific rules before touching PRs.
- Use `gh pr view <num> --json ...` and `gh pr diff <num>` to understand scope and changes.
- Use `gh run list -b <branch>` and `gh run view <run-id> --log-failed` to inspect CI failures.

## Review and comments

- List unresolved review threads with GraphQL and resolve only after fixing:

```bash
gh api graphql -F owner=ORG -F name=REPO -F number=PR_NUM -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id,isResolved,comments(first:10){nodes{id,author{login},body,path}}}}}}}'
```

- Resolve a thread by id:

```bash
gh api graphql -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id,isResolved}}}' -F threadId=THREAD_ID
```

- Reply inline to the original review comment (preferred):

```bash
gh api graphql -F pullRequestId=PR_ID -F inReplyTo=COMMENT_ID -F body="Addressed: ..." \
  -f query='mutation($pullRequestId:ID!,$body:String!,$inReplyTo:ID!){addPullRequestReviewComment(input:{pullRequestId:$pullRequestId,body:$body,inReplyTo:$inReplyTo}){comment{id}}}'
```

- For new inline comments (not replies), prefer the GitHub UI to avoid diff-position errors. Use GraphQL only if you already know the exact `path` and diff `position`.

## PR creation and updates

- Create commits that follow Conventional Commits; keep commits focused.
- Create PRs using the repo template when required:

```bash
cp .github/PULL_REQUEST_TEMPLATE.md /tmp/pr-body.md
# edit /tmp/pr-body.md

gh pr create --body-file /tmp/pr-body.md
```

## Merge

- Ensure checks are green and requested review tasks are resolved.
- Use squash merge unless the user requests otherwise:

```bash
gh pr merge PR_NUM --squash --delete-branch
```
