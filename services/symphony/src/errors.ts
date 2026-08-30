export type SymphonyErrorTag =
  | 'WorkflowError'
  | 'ConfigError'
  | 'TrackerError'
  | 'WorkspaceError'
  | 'CodexProtocolError'
  | 'OrchestratorError'

export type SymphonyErrorCode =
  | 'candidate_fetch_failed'
  | 'codex_not_found'
  | 'dispatch_validation_failed'
  | 'durable_state_error'
  | 'invalid_codex_command'
  | 'invalid_issue_identifier'
  | 'invalid_workspace_cwd'
  | 'leader_election_error'
  | 'linear_api_request'
  | 'linear_api_status'
  | 'linear_graphql_errors'
  | 'linear_graphql_invalid_input'
  | 'linear_missing_end_cursor'
  | 'linear_unknown_payload'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'missing_workflow_file'
  | 'orchestrator_not_started'
  | 'port_exit'
  | 'response_error'
  | 'response_timeout'
  | 'runtime_unavailable'
  | 'startup_failed'
  | 'target_health_check_failed'
  | 'template_parse_error'
  | 'template_render_error'
  | 'turn_cancelled'
  | 'turn_failed'
  | 'turn_input_required'
  | 'turn_timeout'
  | 'unsupported_tracker_kind'
  | 'workflow_front_matter_not_a_map'
  | 'workflow_parse_error'
  | 'workspace_create_failed'
  | 'workspace_hook_error'
  | 'workspace_hook_timeout'
  | 'workspace_path_not_directory'
  | 'worker_aborted'

export abstract class SymphonyError extends Error {
  abstract readonly _tag: SymphonyErrorTag
  readonly code: SymphonyErrorCode
  readonly causeValue: unknown

  protected constructor(code: SymphonyErrorCode, message: string, causeValue?: unknown) {
    super(message)
    this.name = 'SymphonyError'
    this.code = code
    this.causeValue = causeValue
  }
}

export class WorkflowError extends SymphonyError {
  readonly _tag = 'WorkflowError' as const

  constructor(code: SymphonyErrorCode, message: string, causeValue?: unknown) {
    super(code, message, causeValue)
    this.name = 'WorkflowError'
  }
}

export class ConfigError extends SymphonyError {
  readonly _tag = 'ConfigError' as const

  constructor(code: SymphonyErrorCode, message: string, causeValue?: unknown) {
    super(code, message, causeValue)
    this.name = 'ConfigError'
  }
}

export class TrackerError extends SymphonyError {
  readonly _tag = 'TrackerError' as const

  constructor(code: SymphonyErrorCode, message: string, causeValue?: unknown) {
    super(code, message, causeValue)
    this.name = 'TrackerError'
  }
}

export class WorkspaceError extends SymphonyError {
  readonly _tag = 'WorkspaceError' as const

  constructor(code: SymphonyErrorCode, message: string, causeValue?: unknown) {
    super(code, message, causeValue)
    this.name = 'WorkspaceError'
  }
}

export class CodexProtocolError extends SymphonyError {
  readonly _tag = 'CodexProtocolError' as const

  constructor(code: SymphonyErrorCode, message: string, causeValue?: unknown) {
    super(code, message, causeValue)
    this.name = 'CodexProtocolError'
  }
}

export class OrchestratorError extends SymphonyError {
  readonly _tag = 'OrchestratorError' as const

  constructor(code: SymphonyErrorCode, message: string, causeValue?: unknown) {
    super(code, message, causeValue)
    this.name = 'OrchestratorError'
  }
}

export const isSymphonyError = (value: unknown): value is SymphonyError => value instanceof SymphonyError

export const toError = (error: unknown): Error => {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : JSON.stringify(error))
}

export const toLogError = (error: unknown): Record<string, unknown> => {
  if (error instanceof SymphonyError) {
    return {
      error: error.message,
      error_code: error.code,
      error_tag: error._tag,
    }
  }

  return {
    error: toError(error).message,
  }
}
