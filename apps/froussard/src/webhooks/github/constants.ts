export const PROTO_CONTENT_TYPE = 'application/x-protobuf'
export const PROTO_CODEX_TASK_FULL_NAME = 'github.v1.CodexTask'
export const PROTO_CODEX_TASK_SCHEMA = 'github/v1/codex_task.proto'

export const CODEX_PLAN_MARKER = '<!-- codex:plan -->'
export const CODEX_REVIEW_COMMENT = '@codex review'
export const CODEX_READY_COMMENT_MARKER = '<!-- codex:ready -->'
export const CODEX_READY_TO_MERGE_COMMENT = `${CODEX_READY_COMMENT_MARKER}
Codex automation finished review and the pull request is ready to merge.`.trim()
