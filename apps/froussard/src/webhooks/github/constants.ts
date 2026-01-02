export const PROTO_CONTENT_TYPE = 'application/x-protobuf'
export const PROTO_CODEX_TASK_FULL_NAME = 'proompteng.froussard.v1.CodexTask'
export const PROTO_CODEX_TASK_SCHEMA = 'proompteng/froussard/v1/codex_task.proto'

export const CODEX_READY_COMMENT_MARKER = '<!-- codex:ready -->'
export const CODEX_READY_TO_MERGE_COMMENT = `${CODEX_READY_COMMENT_MARKER}
:shipit:`.trim()

export const CODEX_REVIEW_REQUEST_COMMENT_MARKER = '<!-- codex:review-request -->'
export const CODEX_REVIEW_REQUEST_COMMENT = `@codex review
${CODEX_REVIEW_REQUEST_COMMENT_MARKER}`.trim()
