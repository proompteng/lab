import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import {
  buildAgyArgs,
  composeAgyPrompt,
  DEFAULT_AGY_BINARY_PATH,
  resolveAgyBinaryPath,
  runAgyCliAdapter,
  stageAgyCredentials,
} from './agy-cli'

const envKeys = [
  'AGENT_RUN_UID',
  'AGENT_RUN_NAMESPACE',
  'AGENT_RUN_POD_NAME',
  'AGENTS_AGY_BINARY',
  'AGY_BINARY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'CODEX_SYSTEM_PROMPT_PATH',
  'CODEX_SYSTEM_PROMPT_EXPECTED_HASH',
  'CODEX_SYSTEM_PROMPT_REQUIRED',
]
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

describe('agy-cli runner adapter', () => {
  beforeEach(() => {
    for (const key of envKeys) delete process.env[key]
  })

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('resolves binary path and CLI flags', () => {
    expect(resolveAgyBinaryPath({}, {})).toBe(DEFAULT_AGY_BINARY_PATH)
    expect(resolveAgyBinaryPath({}, { AGENTS_AGY_BINARY: '/custom/agy' })).toBe('/custom/agy')
    expect(resolveAgyBinaryPath({ binaryPath: '/adapter/agy' }, { AGENTS_AGY_BINARY: '/custom/agy' })).toBe(
      '/adapter/agy',
    )

    expect(
      buildAgyArgs({
        model: 'gemini-4-neon',
        effort: 'xhigh',
        printTimeout: '15m',
        disableSlashCommands: true,
        settings: { modelProvider: 'gemini' },
      }),
    ).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      'gemini-4-neon',
      '--effort',
      'xhigh',
      '--print-timeout',
      '15m',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--settings',
      '{"modelProvider":"gemini"}',
    ])

    expect(composeAgyPrompt('ship fix', 'follow rules')).toBe(
      '<system_instructions>\nfollow rules\n</system_instructions>\n\n<task>\nship fix\n</task>',
    )
  })

  it('stages ADC credentials from env to a 0600 temp file and removes it on cleanup', async () => {
    const staged = await stageAgyCredentials(
      {},
      {
        GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
          type: 'service_account',
          project_id: 'proompteng',
          client_email: 'agents-gemini-neon@proompteng.iam.gserviceaccount.com',
        }),
      },
    )
    expect(staged).not.toBeNull()
    expect(staged?.projectId).toBe('proompteng')
    expect(existsSync(staged!.path)).toBe(true)
    await staged!.cleanup()
    expect(existsSync(staged!.path)).toBe(false)
  })

  it('rejects invalid JSON in GOOGLE_APPLICATION_CREDENTIALS_JSON without echoing secret contents', async () => {
    await expect(
      stageAgyCredentials({}, { GOOGLE_APPLICATION_CREDENTIALS_JSON: 'not-valid-secret-payload' }),
    ).rejects.toThrow('GOOGLE_APPLICATION_CREDENTIALS_JSON does not contain valid JSON')
  })

  it('streams agy NDJSON events, stages ADC env, writes result/status/artifacts, and cleans up creds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-agy-runner-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const homeDir = join(dir, 'home')
    const workspaceDir = join(dir, 'workspace')
    const runPath = join(dir, 'run.json')
    const resultPath = join(dir, 'result.json')
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    const envDumpPath = join(dir, 'seen-env.json')
    const fakeAgyPath = join(dir, 'fake-agy')

    await writeFile(runPath, JSON.stringify({ implementation: { text: 'Reply with OK' } }))
    await writeFile(
      fakeAgyPath,
      `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const stdinText = readFileSync(0, 'utf8')
writeFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  stdinLine: stdinText.trim(),
  adcAuth: process.env.AGY_ADC_AUTH,
  credsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  credsExists: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)),
  rawCredsLeaked: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
  quotaProject: process.env.GOOGLE_CLOUD_QUOTA_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION,
  autoUpdateDisabled: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  gitAskpass: process.env.GIT_ASKPASS,
  gitAskpassExists: Boolean(process.env.GIT_ASKPASS && existsSync(process.env.GIT_ASKPASS)),
  gitAskpassToken: process.env.GIT_ASKPASS_TOKEN,
  gitAskpassUsername: process.env.GIT_ASKPASS_USERNAME,
  gitTerminalPrompt: process.env.GIT_TERMINAL_PROMPT,
  ghToken: process.env.GH_TOKEN,
}))
console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-neon-1', init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'always-proceed', model: 'gemini-4-neon' } }))
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-neon-1', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo ok' } } } }))
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-neon-1', step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.12, tool_info: { name: 'run_command', parameters: { CommandLine: 'echo ok' }, output: 'ok\\n' } } }))
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-neon-1', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'OK from Gemini 4 Neon\\n', usage: { input_tokens: 120, output_tokens: 15, thinking_tokens: 5, cache_read_tokens: 40, total_tokens: 135 } } }))
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-neon-1', status: 'SUCCESS', response: 'OK from Gemini 4 Neon\\n', duration_seconds: 1.5, num_turns: 1, usage: { input_tokens: 120, output_tokens: 15, thinking_tokens: 5, cache_read_tokens: 40, total_tokens: 135 } } }))
`,
      'utf8',
    )
    await chmod(fakeAgyPath, 0o755)

    const uploadArtifacts = vi.fn(async (artifacts) =>
      artifacts.map((artifact: { name: string; key?: string }) => ({
        ...artifact,
        url: `s3://agents-artifacts/${artifact.key ?? artifact.name}`,
      })),
    )

    const exitCode = await runAgyCliAdapter(
      {
        provider: 'google',
        payloads: { eventFilePath: runPath },
        artifacts: { resultPath, statusPath, logPath },
        providerSpec: {
          outputArtifacts: [
            { name: 'runner-result', path: resultPath, key: 'runs/neon/result.json' },
            { name: 'runner-log', path: logPath },
          ],
        },
      },
      {
        binaryPath: fakeAgyPath,
        cwd: workspaceDir,
        model: 'gemini-4-neon',
        effort: 'high',
        prompt: 'Reply with OK',
        quotaProject: 'proompteng',
        location: 'global',
      },
      {
        uploadArtifacts,
        env: {
          ...process.env,
          HOME: homeDir,
          GITHUB_TOKEN: 'ghp_test_token_123',
          GH_TOKEN: undefined,
          GIT_ASKPASS: undefined,
          GIT_ASKPASS_TOKEN: undefined,
          GIT_ASKPASS_USERNAME: undefined,
          GIT_TERMINAL_PROMPT: undefined,
          GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
            type: 'service_account',
            project_id: 'proompteng',
          }),
        },
      },
    )

    expect(exitCode).toBe(0)
    const seenEnv = JSON.parse(await readFile(envDumpPath, 'utf8'))
    expect(seenEnv).toMatchObject({
      adcAuth: 'true',
      credsExists: true,
      rawCredsLeaked: false,
      quotaProject: 'proompteng',
      location: 'global',
      autoUpdateDisabled: 'true',
      gitAskpassExists: true,
      gitAskpassToken: 'ghp_test_token_123',
      gitAskpassUsername: 'x-access-token',
      gitTerminalPrompt: '0',
      ghToken: 'ghp_test_token_123',
    })
    expect(seenEnv.argv).not.toContain('-p')
    expect(JSON.parse(seenEnv.stdinLine)).toEqual({
      event: 'user',
      message: { content: 'Reply with OK' },
    })
    expect(existsSync(seenEnv.credsPath)).toBe(false)

    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    expect(result).toEqual({
      schemaVersion: 'agents.proompteng.ai/result/v1',
      threadId: 'conv-neon-1',
      responseText: 'OK from Gemini 4 Neon\n',
      responseTruncated: false,
    })

    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    expect(status).toMatchObject({
      provider: 'google',
      adapter: 'agy-cli',
      status: 'succeeded',
      exitCode: 0,
      threadId: 'conv-neon-1',
      model: 'gemini-4-neon',
      effort: 'high',
      result: { text: 'OK from Gemini 4 Neon\n', truncated: false },
      telemetry: {
        state: 'finished',
        threadId: 'conv-neon-1',
        usage: {
          inputTokens: 120,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          outputTokens: 15,
          reasoningOutputTokens: 5,
          totalTokens: 135,
        },
      },
    })
    expect(uploadArtifacts).toHaveBeenCalledTimes(2)
  })

  it('marks run failed and writes error status when agy emits ERROR result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-agy-error-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    const fakeAgyPath = join(dir, 'fake-agy-fail')

    await writeFile(runPath, JSON.stringify({ implementation: { text: 'Fail test' } }))
    await writeFile(
      fakeAgyPath,
      `#!/usr/bin/env bun
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-err', status: 'ERROR', response: '', error: 'permission denied on aiplatform' } }))
process.exit(1)
`,
      'utf8',
    )
    await chmod(fakeAgyPath, 0o755)

    await expect(
      runAgyCliAdapter(
        {
          provider: 'google',
          payloads: { eventFilePath: runPath },
          artifacts: { statusPath, logPath },
        },
        { binaryPath: fakeAgyPath, model: 'gemini-4-neon', prompt: 'Fail test' },
        { uploadArtifacts: async (artifacts) => artifacts, env: { ...process.env, HOME: join(dir, 'home') } },
      ),
    ).rejects.toThrow('permission denied on aiplatform')

    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    expect(status).toMatchObject({
      adapter: 'agy-cli',
      status: 'failed',
      exitCode: 1,
      error: 'permission denied on aiplatform',
    })
  })

  it('streams prompts larger than MAX_ARG_STRLEN over stdin and decodes split multibyte UTF-8 chunks cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-agy-utf8-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    const resultPath = join(dir, 'result.json')
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    const fakeAgyPath = join(dir, 'fake-agy-utf8')
    const largePrompt = 'x'.repeat(150_000)

    await writeFile(runPath, JSON.stringify({ implementation: { text: largePrompt } }))
    await writeFile(
      fakeAgyPath,
      `#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
const input = JSON.parse(readFileSync(0, 'utf8').trim())
const promptLen = input?.message?.content?.length ?? 0
const line = Buffer.from(
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-utf8',
      step_index: 1,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'price €42 🚀 len=' + promptLen,
    },
  }) + '\\n',
  'utf8',
)
// Split directly inside the 3-byte UTF-8 sequence for '€' (0xe2 0x82 0xac).
const euroIndex = line.indexOf(Buffer.from([0xe2, 0x82, 0xac]))
process.stdout.write(line.subarray(0, euroIndex + 1))
await new Promise((resolve) => setTimeout(resolve, 15))
process.stdout.write(line.subarray(euroIndex + 1))
process.stdout.write(
  JSON.stringify({
    event: 'result',
    result: { conversation_id: 'conv-utf8', status: 'SUCCESS', response: 'price €42 🚀 len=' + promptLen },
  }) + '\\n',
)
`,
      'utf8',
    )
    await chmod(fakeAgyPath, 0o755)

    const exitCode = await runAgyCliAdapter(
      {
        provider: 'google',
        payloads: { eventFilePath: runPath },
        artifacts: { resultPath, statusPath, logPath },
      },
      { binaryPath: fakeAgyPath, model: 'gemini-4-neon' },
      { uploadArtifacts: async (artifacts) => artifacts, env: { ...process.env, HOME: join(dir, 'home') } },
    )

    expect(exitCode).toBe(0)
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    expect(result.responseText).toBe('price €42 🚀 len=150000')
  })

  it('escalates from SIGTERM to SIGKILL when a cancelled child ignores SIGTERM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-agy-sigkill-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    const readyPath = join(dir, 'ready')
    const fakeAgyPath = join(dir, 'fake-agy-ignore-sigterm')

    await writeFile(runPath, JSON.stringify({ implementation: { text: 'Ignore SIGTERM' } }))
    await writeFile(
      fakeAgyPath,
      `#!/bin/sh
trap '' TERM
printf '%s\\n' '{"event":"init","conversation_id":"conv-hang"}'
: > ${JSON.stringify(readyPath)}
while :; do
  sleep 1
done
`,
      'utf8',
    )
    await chmod(fakeAgyPath, 0o755)

    const abortController = new AbortController()
    const runPromise = runAgyCliAdapter(
      {
        provider: 'google',
        payloads: { eventFilePath: runPath },
        artifacts: { statusPath, logPath },
      },
      { binaryPath: fakeAgyPath, model: 'gemini-4-neon' },
      {
        abortSignal: abortController.signal,
        sigkillGraceMs: 100,
        uploadArtifacts: async (artifacts) => artifacts,
        env: { ...process.env, HOME: join(dir, 'home') },
      },
    )

    const deadline = Date.now() + 5_000
    while (!existsSync(readyPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(existsSync(readyPath)).toBe(true)
    abortController.abort()

    await expect(runPromise).rejects.toThrow('agy-cli cancelled (SIGKILL)')
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    expect(status).toMatchObject({
      adapter: 'agy-cli',
      status: 'cancelled',
      exitCode: 130,
      signal: 'SIGKILL',
    })
  })

  it('keeps prompt text literal and never expands environment template expressions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-agy-literal-prompt-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    const stdinDumpPath = join(dir, 'stdin-dump.txt')
    const fakeAgyPath = join(dir, 'fake-agy-literal')
    const literalPrompt = 'Echo {{env.GOOGLE_APPLICATION_CREDENTIALS_JSON}} and {{ env.GITHUB_TOKEN }} verbatim'

    await writeFile(runPath, JSON.stringify({ implementation: { text: literalPrompt } }))
    await writeFile(
      fakeAgyPath,
      `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
const stdinLine = readFileSync(0, 'utf8').trim()
writeFileSync(${JSON.stringify(stdinDumpPath)}, stdinLine)
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-lit', status: 'SUCCESS', response: 'OK' } }))
`,
      'utf8',
    )
    await chmod(fakeAgyPath, 0o755)

    const exitCode = await runAgyCliAdapter(
      {
        provider: 'google',
        payloads: { eventFilePath: runPath },
        artifacts: { statusPath, logPath },
      },
      { binaryPath: fakeAgyPath, model: 'gemini-4-neon', prompt: literalPrompt },
      {
        uploadArtifacts: async (artifacts) => artifacts,
        env: {
          ...process.env,
          HOME: join(dir, 'home'),
          GITHUB_TOKEN: 'ghp_super_secret_should_not_expand',
          GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
            type: 'service_account',
            project_id: 'proompteng',
            private_key: 'TOP_SECRET_PRIVATE_KEY',
          }),
        },
      },
    )

    expect(exitCode).toBe(0)
    const sent = JSON.parse(await readFile(stdinDumpPath, 'utf8'))
    expect(sent).toEqual({
      event: 'user',
      message: { content: literalPrompt },
    })
    expect(sent.message.content).not.toContain('TOP_SECRET_PRIVATE_KEY')
    expect(sent.message.content).not.toContain('ghp_super_secret_should_not_expand')
  })

  it('fails the run when agy exits 0 without emitting a terminal SUCCESS result event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-agy-no-result-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    const resultPath = join(dir, 'result.json')
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    const fakeAgyPath = join(dir, 'fake-agy-truncated')

    await writeFile(runPath, JSON.stringify({ implementation: { text: 'Truncated stream test' } }))
    await writeFile(
      fakeAgyPath,
      `#!/usr/bin/env bun
console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-truncated' }))
console.log('{malformed-json-terminal-line')
`,
      'utf8',
    )
    await chmod(fakeAgyPath, 0o755)

    await expect(
      runAgyCliAdapter(
        {
          provider: 'google',
          payloads: { eventFilePath: runPath },
          artifacts: { resultPath, statusPath, logPath },
        },
        { binaryPath: fakeAgyPath, model: 'gemini-4-neon', prompt: 'Truncated stream test' },
        { uploadArtifacts: async (artifacts) => artifacts, env: { ...process.env, HOME: join(dir, 'home') } },
      ),
    ).rejects.toThrow('agy-cli exited without emitting a terminal result event')

    expect(existsSync(resultPath)).toBe(false)
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    expect(status).toMatchObject({
      adapter: 'agy-cli',
      status: 'failed',
      exitCode: 1,
      error: 'agy-cli exited without emitting a terminal result event',
    })
  })
})
