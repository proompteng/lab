import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const LINEAR_PUBLIC_TOOLS = [
  {
    name: 'get_issue',
    description: 'Get the Linear issue bound to this AgentRun.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_comments',
    description: 'List comments on the Linear issue bound to this AgentRun.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_issue_statuses',
    description: 'List valid workflow statuses for the bound Linear issue.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_comment',
    description: 'Create a comment on the Linear issue bound to this AgentRun.',
    inputSchema: {
      type: 'object' as const,
      properties: { body: { type: 'string', minLength: 1, maxLength: 20_000 } },
      required: ['body'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'update_issue',
    description: 'Change the status of the Linear issue bound to this AgentRun.',
    inputSchema: {
      type: 'object' as const,
      properties: { status: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['status'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] satisfies Tool[]

export type LinearPublicToolName = (typeof LINEAR_PUBLIC_TOOLS)[number]['name']

export type LinearUpstreamContract = {
  getIssue: { name: 'get_issue'; issueArgument: 'id' | 'issueId' }
  listComments: { name: 'list_comments'; issueArgument: 'issueId' | 'id' }
  listIssueStatuses: { name: 'list_issue_statuses'; teamArgument: 'team' | 'teamId' }
  createComment: { name: 'save_comment' | 'create_comment'; issueArgument: 'issueId' | 'id' }
  updateIssue: {
    name: 'save_issue' | 'update_issue'
    issueArgument: 'id' | 'issueId'
    statusArgument: 'state' | 'status'
  }
}

export type LinearUpstreamContractValidation =
  | { ok: true; contract: LinearUpstreamContract }
  | { ok: false; errors: string[] }

type UpstreamTool = Pick<Tool, 'name' | 'inputSchema'>

const propertiesFor = (tool: UpstreamTool | undefined) => tool?.inputSchema.properties ?? {}

const requiredFor = (tool: UpstreamTool | undefined) =>
  Array.isArray(tool?.inputSchema.required)
    ? tool.inputSchema.required.filter((entry): entry is string => typeof entry === 'string')
    : []

const schemaAllowsString = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const schema = value as Record<string, unknown>
  if (schema.type === 'string') return true
  if (Array.isArray(schema.type) && schema.type.includes('string')) return true
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((entry) => typeof entry === 'string')) {
    return true
  }
  return [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ].some(schemaAllowsString)
}

const selectProperty = (tool: UpstreamTool | undefined, names: readonly string[]) => {
  const properties = propertiesFor(tool)
  const required = new Set(requiredFor(tool))
  return (
    names.find((name) => required.has(name) && schemaAllowsString(properties[name])) ??
    names.find((name) => schemaAllowsString(properties[name])) ??
    null
  )
}

const selectTool = (tools: Map<string, UpstreamTool>, names: readonly string[]) => {
  for (const name of names) {
    const tool = tools.get(name)
    if (tool) return tool
  }
  return undefined
}

const validateRequiredArguments = (
  tool: UpstreamTool | undefined,
  allowed: readonly (string | null)[],
  label: string,
  errors: string[],
) => {
  if (!tool) return
  const allowedSet = new Set(allowed.filter((entry): entry is string => entry !== null))
  const unsupported = requiredFor(tool).filter((name) => !allowedSet.has(name))
  if (unsupported.length > 0) {
    errors.push(`${label} has unsupported required arguments: ${unsupported.join(', ')}`)
  }
}

export const validateLinearUpstreamContract = (tools: readonly UpstreamTool[]): LinearUpstreamContractValidation => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const errors: string[] = []

  const getIssue = byName.get('get_issue')
  const getIssueArgument = selectProperty(getIssue, ['id', 'issueId'] as const)
  if (!getIssue || !getIssueArgument) errors.push('get_issue must accept id or issueId')
  validateRequiredArguments(getIssue, [getIssueArgument], 'get_issue', errors)

  const listComments = byName.get('list_comments')
  const listCommentsArgument = selectProperty(listComments, ['issueId', 'id'] as const)
  if (!listComments || !listCommentsArgument) errors.push('list_comments must accept issueId or id')
  validateRequiredArguments(listComments, [listCommentsArgument], 'list_comments', errors)

  const listStatuses = byName.get('list_issue_statuses')
  const teamArgument = selectProperty(listStatuses, ['team', 'teamId'] as const)
  if (!listStatuses || !teamArgument) errors.push('list_issue_statuses must accept team or teamId')
  validateRequiredArguments(listStatuses, [teamArgument], 'list_issue_statuses', errors)

  const createComment = selectTool(byName, ['save_comment', 'create_comment'] as const)
  const createCommentArgument = selectProperty(createComment, ['issueId', 'id'] as const)
  if (!createComment || !createCommentArgument || !selectProperty(createComment, ['body'])) {
    errors.push('save_comment or create_comment must accept an issue identifier and body')
  }
  validateRequiredArguments(
    createComment,
    [createCommentArgument, 'body'],
    createComment?.name ?? 'save_comment',
    errors,
  )

  const updateIssue = selectTool(byName, ['save_issue', 'update_issue'] as const)
  const updateIssueArgument = selectProperty(updateIssue, ['id', 'issueId'] as const)
  const updateIssueStatusArgument = selectProperty(updateIssue, ['state', 'status'] as const)
  if (!updateIssue || !updateIssueArgument || !updateIssueStatusArgument) {
    errors.push('save_issue or update_issue must accept an issue identifier and state or status')
  }
  validateRequiredArguments(
    updateIssue,
    [updateIssueArgument, updateIssueStatusArgument],
    updateIssue?.name ?? 'save_issue',
    errors,
  )

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    contract: {
      getIssue: { name: 'get_issue', issueArgument: getIssueArgument as 'id' | 'issueId' },
      listComments: { name: 'list_comments', issueArgument: listCommentsArgument as 'issueId' | 'id' },
      listIssueStatuses: {
        name: 'list_issue_statuses',
        teamArgument: teamArgument as 'team' | 'teamId',
      },
      createComment: {
        name: createComment!.name as 'save_comment' | 'create_comment',
        issueArgument: createCommentArgument as 'issueId' | 'id',
      },
      updateIssue: {
        name: updateIssue!.name as 'save_issue' | 'update_issue',
        issueArgument: updateIssueArgument as 'id' | 'issueId',
        statusArgument: updateIssueStatusArgument as 'state' | 'status',
      },
    },
  }
}

const assertObjectWithExactKeys = (value: unknown, allowed: readonly string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tool arguments must be an object')
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new Error(`unsupported tool arguments: ${unexpected.join(', ')}`)
  return record
}

export const parseLinearPublicToolArguments = (name: LinearPublicToolName, value: unknown) => {
  if (name === 'get_issue' || name === 'list_comments' || name === 'list_issue_statuses') {
    assertObjectWithExactKeys(value ?? {}, [])
    return {}
  }
  if (name === 'create_comment') {
    const record = assertObjectWithExactKeys(value, ['body'])
    const body = typeof record.body === 'string' ? record.body.trim() : ''
    if (!body || body.length > 20_000) throw new Error('body must contain between 1 and 20000 characters')
    return { body }
  }
  const record = assertObjectWithExactKeys(value, ['status'])
  const status = typeof record.status === 'string' ? record.status.trim() : ''
  if (!status || status.length > 200) throw new Error('status must contain between 1 and 200 characters')
  return { status }
}
