import { expect, test } from 'bun:test'

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
