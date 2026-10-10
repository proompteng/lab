import { expect, test } from 'bun:test'

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
    nextPollNotBeforeMs: result.measuredDeadline,
    captureNotStarted: { reason: 'ExpiredUnusedTicket' },
  })
  expect(result.expired.captureNotStarted.expiredByMs).toBeGreaterThanOrEqual(17_000)
  for (const poll of [result.duplicate, result.missing, result.replaced]) {
    expect(poll).toEqual({ _tag: 'Unavailable', nextPollNotBeforeMs: result.reservation.interruptedNotBeforeMs })
  }
  for (const failure of result.failures) {
    expect(failure.completion).toBe('Failure')
    expect(failure.retry).toEqual({
      _tag: 'Unavailable',
      nextPollNotBeforeMs: result.reservation.interruptedNotBeforeMs,
    })
  }
  expect(result.attempts).toBe(0)
  expect(result.invalidations).toBeGreaterThanOrEqual(10)
  const expiryLog = result.logs.find((log: { message: string[] }) =>
    log.message.includes('Broker observation capture expired before starting'),
  )
  expect(expiryLog.annotations).toMatchObject({
    'broker.capture_not_started_reason': 'expired_unused_ticket',
    'broker.capture_start_lateness_ms': result.expired.captureNotStarted.expiredByMs,
  })
  expect(JSON.stringify(result.logs)).not.toContain(result.reservation.captureToken)
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
  expect(result.nextPollNotBeforeMs).toBe(result.poll.nextPollNotBeforeMs)
  expect(result.persistenceTelemetry).toEqual({ loggerInherited: true, tracerInherited: true })
  expect(result.brokerTelemetry).toEqual({ loggerInherited: true, tracerInherited: true })
  const root = result.spans.find((span: { name: string }) => span.name === 'bayn.broker.observation.poll')
  const capture = result.spans.find((span: { name: string }) => span.name === 'bayn.broker.observation.capture')
  const http = result.spans.find((span: { name: string }) => span.name === 'http.client GET')
  expect(root).toMatchObject({ sourceRevision: 'b'.repeat(40) })
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
