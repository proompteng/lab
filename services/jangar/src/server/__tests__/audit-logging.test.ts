import { describe, expect, it } from 'vitest'

import {
  buildAuditPayload,
  resolveAuditContextFromRequest,
  resolveRepositoryContext,
  resolveRepositoryFromParameters,
} from '~/server/audit-logging'

describe('audit logging helpers', () => {
  it('parses repository context consistently', () => {
    expect(resolveRepositoryContext('proompteng/lab')).toEqual({
      repository: 'proompteng/lab',
      repoOwner: 'proompteng',
      repoName: 'lab',
    })
    expect(resolveRepositoryContext('')).toEqual({ repository: null, repoOwner: null, repoName: null })
  })

  it('builds a standard payload shape', () => {
    const payload = buildAuditPayload({
      context: {
        source: 'unit-test',
        actor: 'alice',
        correlationId: 'corr-1',
        requestId: 'req-1',
        deliveryId: 'deliv-1',
        namespace: 'agents',
        repository: 'proompteng/lab',
      },
      details: { action: 'test' },
    })

    expect(payload).toEqual({
      source: 'unit-test',
      actor: 'alice',
      correlationId: 'corr-1',
      requestId: 'req-1',
      deliveryId: 'deliv-1',
      namespace: 'agents',
      repository: 'proompteng/lab',
      repoOwner: 'proompteng',
      repoName: 'lab',
      details: { action: 'test' },
    })
  })

  it('derives correlation ids from headers with a delivery fallback', () => {
    const request = new Request('http://localhost', {
      headers: {
        'x-request-id': 'req-9',
      },
    })
    const context = resolveAuditContextFromRequest(request, {
      deliveryId: 'delivery-9',
      namespace: 'agents',
      repository: 'proompteng/lab',
      source: 'unit-test',
    })

    expect(context.correlationId).toBe('req-9')
    expect(context.requestId).toBe('req-9')
    expect(context.deliveryId).toBe('delivery-9')
  })

  it('detects repository from common parameter keys', () => {
    expect(resolveRepositoryFromParameters({ repository: 'proompteng/lab' })).toBe('proompteng/lab')
    expect(resolveRepositoryFromParameters({ repo: 'proompteng/lab' })).toBe('proompteng/lab')
    expect(resolveRepositoryFromParameters({ issueRepository: 'proompteng/lab' })).toBe('proompteng/lab')
    expect(resolveRepositoryFromParameters({})).toBeNull()
  })
})
