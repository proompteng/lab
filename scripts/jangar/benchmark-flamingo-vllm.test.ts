/// <reference types="bun-types/test-globals" />
import {
  buildLongContextValidator,
  buildLongPrompt,
  buildBenchmarkCommand,
  buildKubectlExecCommand,
  parseBenchmarkOutput,
  validateSmokeResult,
  validateLongContextSmoke,
  type ChatResult,
  smokeValidators,
} from './benchmark-flamingo-vllm'

// ── Command construction tests ───────────────────────────────────────────────

describe('buildBenchmarkCommand', () => {
  it('builds a valid vllm bench serve command', () => {
    const cmd = buildBenchmarkCommand({
      model: 'qwen36-flamingo',
      tokenizer: 'unsloth/Qwen3.6-35B-A3B-NVFP4',
      label: 'short-coding-loop',
      inputLen: 4096,
      outputLen: 512,
      numPrompts: 16,
      concurrency: 4,
      podDir: '/tmp/bench-123',
      resultFile: 'short-coding-loop.json',
    })

    expect(cmd[0]).toBe('vllm')
    expect(cmd).toContain('bench')
    expect(cmd).toContain('serve')
    expect(cmd).toContain('openai-chat')
    expect(cmd).toContain('http://127.0.0.1:8000')
    expect(cmd).toContain('/v1/chat/completions')
    expect(cmd).toContain('qwen36-flamingo')
    expect(cmd).toContain('unsloth/Qwen3.6-35B-A3B-NVFP4')
    expect(cmd).toContain('--trust-remote-code')
    expect(cmd).toContain('--dataset-name')
    expect(cmd).toContain('random')
    expect(cmd).toContain('4096')
    expect(cmd).toContain('512')
    expect(cmd).toContain('16')
    expect(cmd).toContain('4')
    expect(cmd).toContain('--save-result')
    expect(cmd).toContain('/tmp/bench-123')
    expect(cmd).toContain('short-coding-loop.json')
  })

  it('produces identical output for same inputs (pure function)', () => {
    const opts = {
      model: 'qwen36-flamingo',
      tokenizer: 'unsloth/Qwen3.6-35B-A3B-NVFP4',
      label: 'agent-edit-loop',
      inputLen: 32768,
      outputLen: 4096,
      numPrompts: 8,
      concurrency: 2,
      podDir: '/tmp/bench-456',
      resultFile: 'agent-edit-loop.json',
    }
    const first = buildBenchmarkCommand(opts)
    const second = buildBenchmarkCommand(opts)
    expect(first).toEqual(second)
  })
})

describe('buildKubectlExecCommand', () => {
  it('wraps the benchmark command in kubectl exec sh -lc', () => {
    const cmd = buildKubectlExecCommand({
      deployment: 'flamingo',
      podDir: '/tmp/bench-789',
      resultFile: 'short.json',
      label: 'short',
      inputLen: 4096,
      outputLen: 512,
      numPrompts: 4,
      concurrency: 2,
      model: 'qwen36-flamingo',
      tokenizer: 'unsloth/Qwen3.6-35B-A3B-NVFP4',
      kubeContext: 'galactic-tailscale',
      namespace: 'flamingo',
    })

    expect(cmd[0]).toBe('kubectl')
    expect(cmd).toContain('--context')
    expect(cmd).toContain('galactic-tailscale')
    expect(cmd).toContain('-n')
    expect(cmd).toContain('flamingo')
    expect(cmd).toContain('exec')
    expect(cmd).toContain('deploy/flamingo')
    expect(cmd).toContain('sh')
    expect(cmd).toContain('-lc')
    // Verify the inner command is present
    const inner = cmd.join(' ')
    expect(inner).toContain('vllm')
    expect(inner).toContain('bench')
    expect(inner).toContain('serve')
  })

  it('includes the result marker and cat for stdout parsing', () => {
    const cmd = buildKubectlExecCommand({
      deployment: 'flamingo',
      podDir: '/tmp/bench',
      resultFile: 'x.json',
      label: 'x',
      inputLen: 100,
      outputLen: 10,
      numPrompts: 1,
      concurrency: 1,
      model: 'qwen36-flamingo',
      tokenizer: 'test',
      kubeContext: 'ctx',
      namespace: 'ns',
    })
    const inner = cmd.join(' ')
    expect(inner).toContain('__FLAMINGO_BENCH_RESULT_JSON__')
    expect(inner).toContain('cat ')
  })

  it('quotes paths with spaces correctly', () => {
    const cmd = buildKubectlExecCommand({
      deployment: 'flamingo',
      podDir: '/tmp/bench with spaces',
      resultFile: 'x.json',
      label: 'x',
      inputLen: 100,
      outputLen: 10,
      numPrompts: 1,
      concurrency: 1,
      model: 'qwen36-flamingo',
      tokenizer: 'test',
      kubeContext: 'ctx',
      namespace: 'ns',
    })
    const inner = cmd.join(' ')
    // shellQuote wraps with single quotes
    expect(inner).toContain("'/tmp/bench with spaces'")
  })
})

// ── Root metrics URL behavior ─────────────────────────────────────────────────

describe('benchmark output parsing', () => {
  it('parses valid JSON after the marker', () => {
    const validJson = JSON.stringify({ ttft: 100, throughput: 500 })
    const stdout = `some log lines\n\n${validJson}`
    const result = parseBenchmarkOutput(`prefix__FLAMINGO_BENCH_RESULT_JSON__\n${validJson}`)
    expect(result).toEqual({ ttft: 100, throughput: 500 })
  })

  it('returns undefined when marker is absent', () => {
    const result = parseBenchmarkOutput('no marker here\njust output')
    expect(result).toBeUndefined()
  })

  it('returns undefined on JSON parse failure', () => {
    const stdout = `prefix__FLAMINGO_BENCH_RESULT_JSON__\n{invalid json`
    const result = parseBenchmarkOutput(stdout)
    expect(result).toBeUndefined()
  })

  it('handles empty JSON after marker', () => {
    const result = parseBenchmarkOutput(`prefix__FLAMINGO_BENCH_RESULT_JSON__\n`)
    expect(result).toBeUndefined()
  })

  it('finds the last occurrence of the marker', () => {
    const stdout = `first__FLAMINGO_BENCH_RESULT_JSON__\nold\n__FLAMINGO_BENCH_RESULT_JSON__\n{"latest":true}`
    const result = parseBenchmarkOutput(stdout)
    expect(result).toEqual({ latest: true })
  })

  it('parses valid benchmark JSON with numeric throughput', () => {
    const benchJson = {
      total_time_ms: 12345,
      ttft_mean_ms: 100,
      tpot_mean_ms: 5,
      output_throughput: 200,
      total_input_tokens: 10000,
      total_output_tokens: 5000,
      failed: 0,
    }
    const stdout = `__FLAMINGO_BENCH_RESULT_JSON__\n${JSON.stringify(benchJson)}`
    const result = parseBenchmarkOutput(stdout)
    expect(result).toEqual(benchJson)
  })
})

// ── Semantic smoke validation tests ──────────────────────────────────────────

describe('validateSmokeResult — exact-no-thinking', () => {
  it('passes when content contains "qwen36-ready" and finishes cleanly', () => {
    const result: ChatResult = {
      label: 'exact-no-thinking',
      ok: true,
      elapsedMs: 80,
      status: 200,
      response: {
        choices: [
          {
            message: { content: 'qwen36-ready', finish_reason: 'stop' },
          },
        ],
      },
    }
    expect(validateSmokeResult('exact-no-thinking', result)).toEqual([])
  })

  it('passes with finish_reason "length"', () => {
    const result: ChatResult = {
      label: 'exact-no-thinking',
      ok: true,
      elapsedMs: 80,
      response: {
        choices: [{ message: { content: 'qwen36-ready', finish_reason: 'length' } }],
      },
    }
    expect(validateSmokeResult('exact-no-thinking', result)).toEqual([])
  })

  it('fails when content does not contain the marker', () => {
    const result: ChatResult = {
      label: 'exact-no-thinking',
      ok: true,
      elapsedMs: 80,
      response: {
        choices: [{ message: { content: 'hello world', finish_reason: 'stop' } }],
      },
    }
    const errors = validateSmokeResult('exact-no-thinking', result)
    expect(errors).toContainEqual(expect.stringContaining('qwen36-ready'))
  })

  it('fails when HTTP request fails', () => {
    const result: ChatResult = {
      label: 'exact-no-thinking',
      ok: false,
      elapsedMs: 100,
      error: 'Connection refused',
    }
    const errors = validateSmokeResult('exact-no-thinking', result)
    expect(errors).toContain('HTTP-level failure: Connection refused')
  })

  it('fails when response payload is missing', () => {
    const result: ChatResult = {
      label: 'exact-no-thinking',
      ok: true,
      elapsedMs: 10,
      response: null,
    }
    const errors = validateSmokeResult('exact-no-thinking', result)
    expect(errors).toContain('semantic: missing response payload')
  })

  it('fails when choices is missing', () => {
    const result: ChatResult = {
      label: 'exact-no-thinking',
      ok: true,
      elapsedMs: 10,
      response: { data: 'other' },
    }
    const errors = validateSmokeResult('exact-no-thinking', result)
    expect(errors).toContain('semantic: missing choices[0].message')
  })

  it('fails with non-stop finish_reason', () => {
    const result: ChatResult = {
      label: 'exact-no-thinking',
      ok: true,
      elapsedMs: 10,
      response: {
        choices: [{ message: { content: 'qwen36-ready', finish_reason: 'content_filter' } }],
      },
    }
    const errors = validateSmokeResult('exact-no-thinking', result)
    expect(errors).toContainEqual(expect.stringContaining('finish_reason'))
  })
})

describe('validateSmokeResult — medium-thinking', () => {
  it('passes when content contains marker and completion_tokens > 0', () => {
    const result: ChatResult = {
      label: 'medium-thinking',
      ok: true,
      elapsedMs: 3000,
      response: {
        choices: [
          {
            message: {
              content: 'qwen36-thinking-ready',
              finish_reason: 'stop',
              completion_tokens: 745,
            },
          },
        ],
      },
    }
    expect(validateSmokeResult('medium-thinking', result)).toEqual([])
  })

  it('fails when completion_tokens is zero', () => {
    const result: ChatResult = {
      label: 'medium-thinking',
      ok: true,
      elapsedMs: 10,
      response: {
        choices: [{ message: { content: 'qwen36-thinking-ready', finish_reason: 'stop', completion_tokens: 0 } }],
      },
    }
    const errors = validateSmokeResult('medium-thinking', result)
    expect(errors).toContainEqual(expect.stringContaining('completion_tokens'))
  })

  it('fails when content does not contain the marker', () => {
    const result: ChatResult = {
      label: 'medium-thinking',
      ok: true,
      elapsedMs: 10,
      response: {
        choices: [{ message: { content: 'wrong', finish_reason: 'stop', completion_tokens: 100 } }],
      },
    }
    const errors = validateSmokeResult('medium-thinking', result)
    expect(errors).toContainEqual(expect.stringContaining('qwen36-thinking-ready'))
  })

  it('fails with HTTP error', () => {
    const result: ChatResult = {
      label: 'medium-thinking',
      ok: false,
      elapsedMs: 5000,
      error: 'timeout',
    }
    const errors = validateSmokeResult('medium-thinking', result)
    expect(errors).toContain('HTTP-level failure: timeout')
  })
})

describe('validateSmokeResult — tool-call', () => {
  it('passes when tool_calls is structured with id FLAMINGO-262K', () => {
    const result: ChatResult = {
      label: 'tool-call',
      ok: true,
      elapsedMs: 280,
      response: {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'lookup_status',
                    arguments: JSON.stringify({ id: 'FLAMINGO-262K' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    }
    expect(validateSmokeResult('tool-call', result)).toEqual([])
  })

  it('fails when tool_calls is empty', () => {
    const result: ChatResult = {
      label: 'tool-call',
      ok: true,
      elapsedMs: 10,
      response: { choices: [{ message: { tool_calls: [] } }] },
    }
    const errors = validateSmokeResult('tool-call', result)
    expect(errors).toContain('semantic: tool_calls must be a non-empty array')
  })

  it('fails when function name is wrong', () => {
    const result: ChatResult = {
      label: 'tool-call',
      ok: true,
      elapsedMs: 10,
      response: {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'wrong_tool', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
    }
    const errors = validateSmokeResult('tool-call', result)
    expect(errors).toContainEqual(expect.stringContaining('lookup_status'))
  })

  it('fails when arguments id is not FLAMINGO-262K', () => {
    const result: ChatResult = {
      label: 'tool-call',
      ok: true,
      elapsedMs: 10,
      response: {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'lookup_status', arguments: JSON.stringify({ id: 'WRONG-ID' }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    }
    const errors = validateSmokeResult('tool-call', result)
    expect(errors).toContainEqual(expect.stringContaining('FLAMINGO-262K'))
  })

  it('fails when finish_reason is not tool_calls', () => {
    const result: ChatResult = {
      label: 'tool-call',
      ok: true,
      elapsedMs: 10,
      response: {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'lookup_status', arguments: JSON.stringify({ id: 'FLAMINGO-262K' }) },
                },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      },
    }
    const errors = validateSmokeResult('tool-call', result)
    expect(errors).toContainEqual(expect.stringContaining('finish_reason'))
  })

  it('fails when HTTP request fails', () => {
    const result: ChatResult = {
      label: 'tool-call',
      ok: false,
      elapsedMs: 10000,
      error: '502 Bad Gateway',
    }
    const errors = validateSmokeResult('tool-call', result)
    expect(errors).toContain('HTTP-level failure: 502 Bad Gateway')
  })

  it('fails when arguments is not valid JSON', () => {
    const result: ChatResult = {
      label: 'tool-call',
      ok: true,
      elapsedMs: 10,
      response: {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'lookup_status', arguments: 'not-json' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    }
    const errors = validateSmokeResult('tool-call', result)
    expect(errors).toContain('semantic: tool_calls[0].function.arguments is not valid JSON')
  })

  it('fails when arguments does not parse to an object with id', () => {
    const result: ChatResult = {
      label: 'tool-call',
      ok: true,
      elapsedMs: 10,
      response: {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'lookup_status', arguments: JSON.stringify([]) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    }
    const errors = validateSmokeResult('tool-call', result)
    expect(errors).toContainEqual(expect.stringContaining('arguments'))
  })
})

// ── Long-context smoke validation ─────────────────────────────────────────────

describe('validateLongContextSmoke', () => {
  it('passes when content includes the expected marker', () => {
    const result: ChatResult = {
      label: 'long-context-220000',
      ok: true,
      elapsedMs: 34000,
      response: {
        choices: [{ message: { content: 'flamingo-long-220000', finish_reason: 'stop' } }],
      },
    }
    expect(validateLongContextSmoke(result, 'flamingo-long-220000')).toEqual([])
  })

  it('fails when content does not include the marker', () => {
    const result: ChatResult = {
      label: 'long-context-220000',
      ok: true,
      elapsedMs: 100,
      response: {
        choices: [{ message: { content: 'no marker here', finish_reason: 'stop' } }],
      },
    }
    const errors = validateLongContextSmoke(result, 'flamingo-long-220000')
    expect(errors).toContainEqual(expect.stringContaining('flamingo-long-220000'))
  })

  it('fails on HTTP error', () => {
    const result: ChatResult = {
      label: 'long-context-220000',
      ok: false,
      elapsedMs: 10000,
      error: 'timeout',
    }
    const errors = validateLongContextSmoke(result, 'flamingo-long-220000')
    expect(errors).toContain('HTTP-level failure: timeout')
  })

  it('fails on missing choices[0].message', () => {
    const result: ChatResult = {
      label: 'long-context-220000',
      ok: true,
      elapsedMs: 10,
      response: {},
    }
    const errors = validateLongContextSmoke(result, 'flamingo-long-220000')
    expect(errors).toContain('missing choices[0].message')
  })

  it('fails on non-string content', () => {
    const result: ChatResult = {
      label: 'long-context-220000',
      ok: true,
      elapsedMs: 10,
      response: {
        choices: [{ message: { content: 42, finish_reason: 'stop' } }],
      },
    }
    const errors = validateLongContextSmoke(result, 'flamingo-long-220000')
    expect(errors).toContain('content is not a string')
  })

  it('fails on bad finish_reason', () => {
    const result: ChatResult = {
      label: 'long-context-220000',
      ok: true,
      elapsedMs: 10,
      response: {
        choices: [{ message: { content: 'flamingo-long-220000', finish_reason: 'content_filter' } }],
      },
    }
    const errors = validateLongContextSmoke(result, 'flamingo-long-220000')
    expect(errors).toContainEqual(expect.stringContaining('finish_reason'))
  })
})

describe('buildLongContextValidator', () => {
  it('produces a validator function for expected markers', () => {
    const validator = buildLongContextValidator('flamingo-long-180000')
    const pass: ChatResult = {
      label: 'test',
      ok: true,
      elapsedMs: 100,
      response: {
        choices: [{ message: { content: 'flamingo-long-180000', finish_reason: 'stop' } }],
      },
    }
    const fail: ChatResult = {
      label: 'test',
      ok: true,
      elapsedMs: 100,
      response: {
        choices: [{ message: { content: 'wrong', finish_reason: 'stop' } }],
      },
    }
    expect(validator(pass)).toBeNull()
    expect(validator(fail)).not.toBeNull()
  })
})

// ── buildLongPrompt ──────────────────────────────────────────────────────────

describe('buildLongPrompt', () => {
  it('includes the marker in instruction and return line', () => {
    const prompt = buildLongPrompt(5, 'flamingo-long-5')
    expect(prompt).toContain('Remember the marker flamingo-long-5.')
    expect(prompt).toContain('Return exactly: flamingo-long-5')
    expect(prompt).toContain('flamingo-long-5')
  })

  it('produces a prompt with approximately the right number of fill tokens', () => {
    const prompt = buildLongPrompt(100, 'marker')
    // Each 'x ' pair is one token approximation, plus instruction and return lines
    const lines = prompt.split('\n')
    // First line: "Remember the marker marker."
    // Second line: "The following filler..."
    // Third line: 100 x's
    // Fourth line: "Return exactly: marker"
    expect(lines.length).toBe(4)
    expect(lines[2]).toBe('x '.repeat(100))
  })

  it('is deterministic for same inputs', () => {
    const first = buildLongPrompt(256, 'my-marker')
    const second = buildLongPrompt(256, 'my-marker')
    expect(first).toBe(second)
  })
})

// ── Integration: smoke result shapes ─────────────────────────────────────────

describe('ChatResult shape completeness', () => {
  it('all required smoke labels have validators', () => {
    const labels = ['exact-no-thinking', 'medium-thinking', 'tool-call']
    for (const label of labels) {
      expect(smokeValidators[label]).toBeDefined()
    }
  })
})
