import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as chatServer from '~/server/chat'
import {
  getTorghutDecisionRun,
  parseDecisionEngineRequest,
  resetTorghutDecisionEngineForTests,
  setTorghutDecisionExecutorForTests,
  submitTorghutDecisionRun,
  subscribeTorghutDecisionRunEvents,
} from '~/server/torghut-decision-engine'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForTerminalState = async (runId: string, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = getTorghutDecisionRun(runId)
    if (run && ['completed', 'error', 'timeout'].includes(run.state)) {
      return run
    }
    await sleep(10)
  }
  throw new Error('timeout waiting for terminal run state')
}

const requestPayload = {
  request_id: 'req-normal',
  symbol: 'NVDA',
  strategy_id: 'intraday-v3',
  trigger: { type: 'signal_cross', source: 'torghut-ta' },
  portfolio: { equity: '100000', buying_power: '250000' },
  risk_policy: { max_notional_per_trade: '7000', kill_switch_enabled: false },
  execution_context: { primary_adapter: 'alpaca', mode: 'paper' },
  llm_review: {
    model: 'gpt-5.3-codex',
    messages: [{ role: 'user', content: 'review this decision as json' }],
  },
}

describe('torghut decision engine', () => {
  const originalTimeout = process.env.JANGAR_TORGHUT_DECISION_RUN_TIMEOUT_MS

  beforeEach(() => {
    process.env.JANGAR_TORGHUT_DECISION_RUN_TIMEOUT_MS = '200'
    resetTorghutDecisionEngineForTests()
  })

  afterEach(() => {
    process.env.JANGAR_TORGHUT_DECISION_RUN_TIMEOUT_MS = originalTimeout
    vi.restoreAllMocks()
    resetTorghutDecisionEngineForTests()
  })

  it('completes a run and records lifecycle events', async () => {
    const parsed = parseDecisionEngineRequest(requestPayload)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unexpected parse failure')

    setTorghutDecisionExecutorForTests(async ({ emitProgress }) => {
      emitProgress('loading market context', { stage: 'market_context' })
      await sleep(5)
      return {
        decisionIntent: {
          action: 'hold',
          symbol: 'NVDA',
          strategy_id: 'intraday-v3',
          confidence: 0.8,
          qty: '0',
          adapter_hint: 'alpaca',
          rationale: 'unit test result',
          risk_flags: [],
        },
        llmResponse: {
          content: '{"verdict":"approve","confidence":0.9,"rationale":"ok","risk_flags":[]}',
          usage: { prompt_tokens: 10, completion_tokens: 11, total_tokens: 21 },
        },
      }
    })

    const submit = submitTorghutDecisionRun(parsed.value)
    const terminal = await waitForTerminalState(submit.run.runId)

    expect(submit.idempotent).toBe(false)
    expect(terminal.state).toBe('completed')
    expect(terminal.finalPayload?.decision_intent).toBeTruthy()
    expect(terminal.finalPayload?.llm_response).toBeTruthy()
  })

  it('marks a run as timeout when execution exceeds configured timeout', async () => {
    process.env.JANGAR_TORGHUT_DECISION_RUN_TIMEOUT_MS = '25'
    resetTorghutDecisionEngineForTests()

    const parsed = parseDecisionEngineRequest({ ...requestPayload, request_id: 'req-timeout' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unexpected parse failure')

    setTorghutDecisionExecutorForTests(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              decisionIntent: { action: 'hold', symbol: 'NVDA' },
              llmResponse: null,
            })
          }, 250)

          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }),
    )

    const submit = submitTorghutDecisionRun(parsed.value)
    const terminal = await waitForTerminalState(submit.run.runId)

    expect(terminal.state).toBe('timeout')
    expect(terminal.error?.code).toBe('timeout')
  })

  it('deduplicates by request_id and keeps run alive across subscriber disconnect', async () => {
    const parsed = parseDecisionEngineRequest({ ...requestPayload, request_id: 'req-idempotent' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unexpected parse failure')

    let executorCalls = 0
    setTorghutDecisionExecutorForTests(async () => {
      executorCalls += 1
      await sleep(30)
      return {
        decisionIntent: { action: 'hold', symbol: 'NVDA' },
        llmResponse: null,
      }
    })

    const first = submitTorghutDecisionRun(parsed.value)
    const unsubscribe = subscribeTorghutDecisionRunEvents(first.run.runId, () => {})

    const second = submitTorghutDecisionRun(parsed.value)
    unsubscribe?.()

    const terminal = await waitForTerminalState(first.run.runId)

    expect(second.idempotent).toBe(true)
    expect(second.run.runId).toBe(first.run.runId)
    expect(executorCalls).toBe(1)
    expect(terminal.state).toBe('completed')
  })

  it('forwards llm review temperature and max_tokens to chat completion payload', async () => {
    let seenBody: unknown = null
    vi.spyOn(chatServer, 'handleChatCompletion').mockImplementation(async (request: Request) => {
      seenBody = await request.json()
      const payload = [
        'data: {"choices":[{"delta":{"content":"{\\"verdict\\":\\"approve\\"}"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')
      return new Response(payload, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const parsed = parseDecisionEngineRequest({
      ...requestPayload,
      request_id: 'req-controls',
      llm_review: {
        ...requestPayload.llm_review,
        temperature: 0.2,
        max_tokens: 321,
      },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unexpected parse failure')

    const submit = submitTorghutDecisionRun(parsed.value)
    const terminal = await waitForTerminalState(submit.run.runId)

    expect(terminal.state).toBe('completed')
    expect(seenBody).toMatchObject({
      temperature: 0.2,
      max_tokens: 321,
    })
  })
})
