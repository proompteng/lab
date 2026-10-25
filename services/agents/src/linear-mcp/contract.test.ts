import { describe, expect, it } from 'vitest'

import { LINEAR_PUBLIC_TOOLS, parseLinearPublicToolArguments, validateLinearUpstreamContract } from './contract'

const tool = (name: string, properties: Record<string, object>, required?: string[]) => ({
  name,
  inputSchema: { type: 'object' as const, properties, ...(required ? { required } : {}) },
})

describe('Linear MCP contract', () => {
  it('pins the current official save tool contract without exposing new upstream tools', () => {
    const result = validateLinearUpstreamContract([
      tool('get_issue', { id: { type: 'string' } }),
      tool('list_comments', { issueId: { type: 'string' } }),
      tool('list_issue_statuses', { team: { type: 'string' } }),
      tool('save_comment', { issueId: { type: 'string' }, body: { type: 'string' }, id: { type: 'string' } }),
      tool('save_issue', { id: { type: 'string' }, state: { type: 'string' }, title: { type: 'string' } }),
      tool('delete_issue', { id: { type: 'string' } }),
    ])

    expect(result).toEqual({
      ok: true,
      contract: {
        getIssue: { name: 'get_issue', issueArgument: 'id' },
        listComments: { name: 'list_comments', issueArgument: 'issueId' },
        listIssueStatuses: { name: 'list_issue_statuses', teamArgument: 'team' },
        createComment: { name: 'save_comment', issueArgument: 'issueId' },
        updateIssue: { name: 'save_issue', issueArgument: 'id', statusArgument: 'state' },
      },
    })
    expect(LINEAR_PUBLIC_TOOLS.map(({ name }) => name)).toEqual([
      'get_issue',
      'list_comments',
      'list_issue_statuses',
      'create_comment',
      'update_issue',
    ])
  })

  it('fails readiness when a required mutation field drifts', () => {
    const result = validateLinearUpstreamContract([
      tool('get_issue', { id: { type: 'string' } }),
      tool('list_comments', { issueId: { type: 'string' } }),
      tool('list_issue_statuses', { team: { type: 'string' } }),
      tool('save_comment', { issueId: { type: 'string' }, body: { type: 'string' } }),
      tool('save_issue', { id: { type: 'string' }, stateId: { type: 'string' } }),
    ])

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('state or status')] })
  })

  it('fails readiness when a required upstream argument no longer accepts a string', () => {
    const result = validateLinearUpstreamContract([
      tool('get_issue', { id: { type: 'number' } }),
      tool('list_comments', { issueId: { type: 'string' } }),
      tool('list_issue_statuses', { team: { type: 'string' } }),
      tool('save_comment', { issueId: { type: 'string' }, body: { type: 'string' } }),
      tool('save_issue', { id: { type: 'string' }, state: { type: 'string' } }),
    ])

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('get_issue')] })
  })

  it('fails readiness when an upstream tool adds an argument the gateway cannot supply', () => {
    const result = validateLinearUpstreamContract([
      tool('get_issue', { id: { type: 'string' }, workspace: { type: 'string' } }, ['id', 'workspace']),
      tool('list_comments', { issueId: { type: 'string' } }),
      tool('list_issue_statuses', { team: { type: 'string' } }),
      tool('save_comment', { issueId: { type: 'string' }, body: { type: 'string' } }),
      tool('save_issue', { id: { type: 'string' }, state: { type: 'string' } }),
    ])

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('unsupported required arguments: workspace')],
    })
  })

  it('selects the compatible alias required by the upstream tool', () => {
    const result = validateLinearUpstreamContract([
      tool('get_issue', { id: { type: 'string' }, issueId: { type: 'string' } }, ['issueId']),
      tool('list_comments', { issueId: { type: 'string' } }),
      tool('list_issue_statuses', { team: { type: 'string' } }),
      tool('save_comment', { issueId: { type: 'string' }, body: { type: 'string' } }),
      tool('save_issue', { id: { type: 'string' }, state: { type: 'string' } }),
    ])

    expect(result).toMatchObject({ ok: true, contract: { getIssue: { issueArgument: 'issueId' } } })
  })

  it('rejects issue, team, project, and extra identifiers from public calls', () => {
    expect(() => parseLinearPublicToolArguments('get_issue', { id: 'PROOMPT-999' })).toThrow(
      'unsupported tool arguments',
    )
    expect(() => parseLinearPublicToolArguments('create_comment', { body: 'ok', issueId: 'PROOMPT-999' })).toThrow(
      'unsupported tool arguments',
    )
    expect(() => parseLinearPublicToolArguments('update_issue', { status: 'Done', project: 'secret' })).toThrow(
      'unsupported tool arguments',
    )
  })
})
