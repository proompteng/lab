import { expect, test } from 'bun:test'
import { observationUnavailable } from '../broker/alpaca/observed-snapshot'
import { ValkeyCacheError, ValkeyFailureCategory } from '../valkey-cache'
import { brokerPublicationFailureAnnotations } from './broker-observation-runtime'

test('publication diagnostics expose only allowlisted fields, without inspecting raw cause details', () => {
  let reads = 0
  const hostile = Object.defineProperties(
    {},
    Object.fromEntries(
      ['name', 'message', 'stack', 'code', 'cause', 'toString'].map((name) => [
        name,
        {
          get: () => {
            reads++
            throw new Error('private fixture detail')
          },
        },
      ]),
    ),
  )
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const cyclic: { cause?: unknown } = {}
  cyclic.cause = cyclic
  const unknown = {
    'broker.publication_dependency': 'unknown',
    'broker.publication_operation': 'unknown',
    'broker.publication_failure_category': 'unknown',
    'broker.publication_cause_category': 'unknown',
  }
  for (const cause of [
    undefined,
    null,
    'private fixture detail',
    new Error('private fixture detail'),
    hostile,
    revoked.proxy,
    cyclic,
  ])
    expect(brokerPublicationFailureAnnotations(observationUnavailable('private wrapper', cause))).toEqual(unknown)
  const malformed = Object.assign(
    new ValkeyCacheError({ operation: 'private key', message: 'private value', cause: hostile }),
    {
      category: 'private credential',
      causeCategory: 'private nested credential',
    },
  )
  expect(brokerPublicationFailureAnnotations(observationUnavailable('private wrapper', malformed))).toEqual({
    ...unknown,
    'broker.publication_dependency': 'valkey',
  })
  const getter = () => {
    reads++
    throw new Error('private accessor detail')
  }
  const getterWrapper = observationUnavailable('private wrapper')
  Object.defineProperty(getterWrapper, 'cause', { get: getter })
  expect(brokerPublicationFailureAnnotations(getterWrapper)).toEqual(unknown)
  const getterCache = new ValkeyCacheError({ operation: 'put', message: 'private value' })
  Object.defineProperties(getterCache, {
    operation: { get: getter },
    category: { get: getter },
    causeCategory: { get: getter },
  })
  expect(brokerPublicationFailureAnnotations(observationUnavailable('private wrapper', getterCache))).toEqual({
    ...unknown,
    'broker.publication_dependency': 'valkey',
  })
  const hostilePrototype = new Proxy({}, { getPrototypeOf: getter, get: getter })
  for (const cause of [hostilePrototype, Object.setPrototypeOf(new Error('private native detail'), hostilePrototype)])
    expect(brokerPublicationFailureAnnotations(observationUnavailable('private wrapper', cause))).toEqual(unknown)
  expect(reads).toBe(0)
})

test('failed publication logs safe diagnostics after invalidation and preserves nested causes', async () => {
  const child = Bun.spawn(['bun', `${import.meta.dir}/broker-observation-publication.test-support.ts`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  const line = stdout.split('\n').find((value) => value.startsWith('PUBLICATION_RESULT='))
  if (line === undefined) throw new Error(`Publication worker returned no result: ${stdout}`)
  const result = JSON.parse(line.slice('PUBLICATION_RESULT='.length))
  const categories = [...Object.values(ValkeyFailureCategory), ValkeyFailureCategory.OperationDeadline, 'unknown']
  expect(result.polls).toHaveLength(categories.length)
  expect(result.retainedCauses).toEqual(categories.map(() => true))
  expect(result.invalidations).toBe(categories.length)
  expect(result.publications).toBe(0)
  for (const poll of result.polls)
    expect(poll).toEqual({ _tag: 'Unavailable', nextPollNotBeforeMs: expect.any(Number) })
  const logs = result.logs.filter((log: { message: string[] }) =>
    log.message.includes('Broker observation publication failed'),
  )
  expect(logs).toHaveLength(categories.length)
  for (const [index, category] of categories.entries())
    expect(logs[index].annotations).toMatchObject({
      'broker.publication_dependency': 'valkey',
      'broker.publication_operation': category === 'unknown' ? 'unknown' : 'put',
      'broker.publication_failure_category': category,
      'broker.publication_cause_category':
        index === categories.length - 2 ? ValkeyFailureCategory.ReplicaAcknowledgement : 'unknown',
    })
  expect(JSON.stringify(result.logs)).not.toContain('private-account-key-value-credential-fixture')
})

test('only a matching unused expired capture releases speculative debt after invalidation', async () => {
  const child = Bun.spawn(['bun', `${import.meta.dir}/broker-observation-capture-claim.test-support.ts`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  const line = stdout.split('\n').find((value) => value.startsWith('CAPTURE_CLAIM_RESULT='))
  if (line === undefined) throw new Error(`Capture claim worker returned no result: ${stdout}`)
  const result = JSON.parse(line.slice('CAPTURE_CLAIM_RESULT='.length))
  expect(result.expired).toMatchObject({
    _tag: 'Unavailable',
    nextPollNotBeforeMs: expect.any(Number),
    captureNotStarted: { reason: 'ExpiredUnusedTicket' },
  })
  expect(result.expired.captureNotStarted.expiredByMs).toBeGreaterThanOrEqual(17_000)
  for (const poll of [result.duplicate, result.replaced]) {
    expect(poll).toEqual({ _tag: 'Unavailable', nextPollNotBeforeMs: result.reservation.interruptedNotBeforeMs })
  }
  for (const failure of result.failures) {
    expect(failure.completion).toBe('Failure')
    expect(failure.retry).toEqual({
      _tag: 'Unavailable',
      nextPollNotBeforeMs: failure.deadline,
    })
  }
  expect(result.attempts).toBe(0)
  expect(result.claims).toBe(5)
  expect(result.regression).toBe('Failure')
  expect(result.regressionRetry).toEqual({ _tag: 'Unavailable', nextPollNotBeforeMs: result.regressionDeadline })
  expect(result.invalidations).toBeGreaterThanOrEqual(4)
  const expiryLog = result.logs.find((log: { message: string[] }) =>
    log.message.includes('Broker observation capture expired before starting'),
  )
  expect(expiryLog.annotations).toMatchObject({
    'broker.capture_not_started_reason': 'expired_unused_ticket',
    'broker.capture_start_lateness_ms': result.expired.captureNotStarted.expiredByMs,
  })
  expect(JSON.stringify(result.logs)).not.toContain(result.reservation.captureId)
})

test('failed capture disposes lazy broker acquisition before returning measured quota after persistence failure', async () => {
  const child = Bun.spawn(['bun', `${import.meta.dir}/broker-observation-runtime.test-support.ts`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  const line = stdout.split('\n').find((value) => value.startsWith('BROKER_POLL_RESULT='))
  if (line === undefined) throw new Error(`Broker poll worker returned no result: ${stdout}`)
  const result = JSON.parse(line.slice('BROKER_POLL_RESULT='.length))
  expect(result.poll._tag).toBe('Unavailable')
  expect(result.attemptsAtReturn).toBe(1)
  expect(result.attemptsAfterReturn).toBe(1)
  expect(result.persistenceTelemetry).toEqual({ loggerInherited: true, tracerInherited: true })
  expect(result.brokerTelemetry).toEqual({ loggerInherited: true, tracerInherited: true })
  const root = result.spans.find((span: { name: string }) => span.name === 'bayn.broker.observation.poll')
  const capture = result.spans.find((span: { name: string }) => span.name === 'bayn.broker.observation.capture')
  const http = result.spans.find((span: { name: string }) => span.name === 'http.client GET')
  expect(root).toMatchObject({
    sourceRevision: 'b'.repeat(40),
    traceId: 'a'.repeat(32),
    parentSpanId: 'b'.repeat(16),
  })
  expect(capture).toMatchObject({ parentSpanId: root.spanId, traceId: root.traceId })
  expect(http).toMatchObject({ name: 'http.client GET' })
  expect(result.logs).toContainEqual({
    message: 'Broker observation poll completed without publication',
    annotations: {
      sourceRevision: 'b'.repeat(40),
      trace_id: root.traceId,
      span_id: root.spanId,
    },
  })
})

test.each(['invalid-response', 'defect', 'interruption'])(
  'preserves broker acquisition %s without reporting a false timeout or settling unknown work',
  async (mode) => {
    const child = Bun.spawn(['bun', `${import.meta.dir}/broker-observation-runtime.test-support.ts`, mode], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    const line = stdout.split('\n').find((value) => value.startsWith('BROKER_POLL_RESULT='))
    if (line === undefined) throw new Error(`Broker poll worker returned no result: ${stdout}`)
    const result = JSON.parse(line.slice('BROKER_POLL_RESULT='.length))
    expect(result.attemptsAtReturn).toBe(1)
    expect(result.attemptsAfterReturn).toBe(1)
    expect(result.mutationInvalidations).toBe(0)
    expect(result.interruptedCaptures).toEqual(
      mode === 'interruption'
        ? [{ accountId: 'test-account', sourceRevision: 'b'.repeat(40), captureId: 'test-capture' }]
        : [],
    )
    if (mode === 'invalid-response') {
      expect(result.failed).toBe(false)
      expect(result.poll._tag).toBe('Unavailable')
      expect(result.settlements).toBe(1)
      expect(result.logs).toContainEqual({
        message: 'Broker observation poll failed',
        annotations: expect.objectContaining({
          'broker.operation': 'positions',
          'broker.failure_kind': 'INVALID_RESPONSE',
          'broker.retryable': false,
          'broker.http_status': 200,
        }),
      })
    } else {
      expect(result.failed).toBe(true)
      expect(result.poll).toBeUndefined()
      expect(result.settlements).toBe(0)
    }
    expect(JSON.stringify(result.logs)).not.toContain('synthetic private response detail')
  },
)
