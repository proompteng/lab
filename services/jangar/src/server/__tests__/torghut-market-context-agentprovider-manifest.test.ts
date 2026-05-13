import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const extractInputFileContent = (manifest: string, path: string): string => {
  const lines = manifest.split('\n')
  const pathLine = `    - path: ${path}`
  const startIndex = lines.findIndex((line) => line === pathLine)

  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(lines[startIndex + 1]).toBe('      content: |-')

  const contentLines: string[] = []
  for (const line of lines.slice(startIndex + 2)) {
    if (line.startsWith('    - path: ')) {
      break
    }
    if (line === '') {
      contentLines.push('')
      continue
    }
    if (!line.startsWith('        ')) {
      break
    }
    contentLines.push(line.slice(8))
  }

  return contentLines.join('\n')
}

describe('torghut market-context AgentProvider manifest', () => {
  it('retries fundamentals batches during the regular market session', async () => {
    const manifest = await readFile(
      resolve(process.cwd(), '..', '..', 'argocd/applications/agents/torghut-market-context-batch.yaml'),
      'utf8',
    )

    expect(manifest).toContain('name: torghut-market-context-fundamentals-batch')
    expect(manifest).toContain('cron: "35 9-15/2 * * 1-5"')
  })

  it('marks preopen probes as no-VCS batch tasks', async () => {
    const manifest = await readFile(
      resolve(process.cwd(), '..', '..', 'argocd/applications/agents/torghut-market-context-batch.yaml'),
      'utf8',
    )

    for (const templateName of [
      'torghut-market-context-fundamentals-preopen-probe-template',
      'torghut-market-context-news-preopen-probe-template',
    ]) {
      const start = manifest.indexOf(`name: ${templateName}`)
      expect(start).toBeGreaterThanOrEqual(0)
      const nextDocument = manifest.indexOf('\n---', start)
      const section = manifest.slice(start, nextDocument === -1 ? undefined : nextDocument)
      expect(section).toContain('executionMode: batch_task')
      expect(section).toContain('provider: codex-spark')
    }
  })

  it('uses a bearer token for lifecycle start/progress requests', async () => {
    const manifest = await readFile(
      resolve(process.cwd(), '..', '..', 'argocd/applications/agents/torghut-market-context-agentprovider.yaml'),
      'utf8',
    )

    expect(manifest).toContain("DEFAULT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'")
    expect(manifest).toContain('token = _load_bearer_token()')
    expect(manifest).toContain("headers['authorization'] = f'Bearer {token}'")
  })

  it('mounts the market-context lifecycle helper scripts at the instructed skill path', async () => {
    const manifest = await readFile(
      resolve(process.cwd(), '..', '..', 'argocd/applications/agents/torghut-market-context-agentprovider.yaml'),
      'utf8',
    )
    const runApi = extractInputFileContent(
      manifest,
      '/root/.codex/skills/market-context/scripts/market_context_run_api.py',
    )
    const validator = extractInputFileContent(
      manifest,
      '/root/.codex/skills/market-context/scripts/validate_market_context_payload.py',
    )
    const tempDir = await mkdtemp(resolve(tmpdir(), 'market-context-scripts-'))
    const runApiPath = resolve(tempDir, 'market_context_run_api.py')
    const validatorPath = resolve(tempDir, 'validate_market_context_payload.py')
    const payloadPath = resolve(tempDir, 'market-context-news.json')
    await writeFile(runApiPath, runApi)
    await writeFile(validatorPath, validator)
    await writeFile(
      payloadPath,
      JSON.stringify({
        symbol: 'AMD',
        domain: 'news',
        asOfUtc: '2026-05-12T18:00:00.000Z',
        sourceCount: 2,
        qualityScore: 0.75,
        payload: { headlines: [{ title: 'Market-context smoke payload' }] },
        citations: [
          { source: 'AMD', publishedAt: '2026-05-12T17:00:00.000Z', url: 'https://example.com/amd' },
          { source: 'SEC', publishedAt: '2026-05-12T17:30:00.000Z', url: 'https://example.com/sec' },
        ],
        riskFlags: [],
        provider: 'codex',
        runStatus: 'succeeded',
        requestId: 'market-context-news-amd-smoke',
      }),
    )

    await execFileAsync('python3', ['-m', 'py_compile', runApiPath, validatorPath], { timeout: 10_000 })
    await execFileAsync('python3', [validatorPath, '--domain', 'news', '--file', payloadPath], { timeout: 10_000 })
  })

  it('decodes timeout output before writing process streams', async () => {
    const manifest = await readFile(
      resolve(process.cwd(), '..', '..', 'argocd/applications/agents/torghut-market-context-agentprovider.yaml'),
      'utf8',
    )

    expect(manifest).toContain('def _write_process_output(stream, output) -> None:')
    expect(manifest).toContain('if isinstance(output, bytes):')
    expect(manifest).toContain("output.decode('utf-8', errors='replace')")
    expect(manifest).toContain('_write_process_output(sys.stdout, error.stdout)')
    expect(manifest).toContain('_write_process_output(sys.stderr, error.stderr)')
    expect(manifest).toContain('CODEX_MARKET_CONTEXT_PREFLIGHT_TIMEOUT_SECONDS: "10"')
  })

  it('preflights closed market sessions before running Codex attempts', async () => {
    const manifest = await readFile(
      resolve(process.cwd(), '..', '..', 'argocd/applications/agents/torghut-market-context-agentprovider.yaml'),
      'utf8',
    )
    const runner = extractInputFileContent(manifest, '/root/.codex/market-context-provider-runner.py')
    const tempDir = await mkdtemp(resolve(tmpdir(), 'market-context-runner-'))
    const runnerPath = resolve(tempDir, 'market-context-provider-runner.py')
    const eventPath = resolve(tempDir, 'event.json')
    const probePath = resolve(tempDir, 'probe.py')
    await writeFile(runnerPath, runner)
    await writeFile(
      eventPath,
      JSON.stringify({
        parameters: {
          domain: 'fundamentals',
          executionMode: 'batch_task',
          tradingStatusUrl: 'http://torghut.test/trading/status',
        },
      }),
    )
    await writeFile(
      probePath,
      `
import importlib.util
import sys
from pathlib import Path

runner_path = Path(sys.argv[1])
event_path = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location('runner', runner_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

class FakeResponse:
  def __enter__(self):
    return self

  def __exit__(self, exc_type, exc, tb):
    return False

  def read(self):
    return b'{"signal_continuity":{"market_session_open":false}}'

def fake_urlopen(request, timeout=0):
  assert timeout == 10
  assert request.full_url == 'http://torghut.test/trading/status'
  return FakeResponse()

def fail_run(*args, **kwargs):
  raise AssertionError('codex attempt should not run while market is closed')

module.urllib.request.urlopen = fake_urlopen
module.subprocess.run = fail_run
sys.argv = ['market-context-provider-runner.py', str(event_path)]
exit_code = module.main()
assert exit_code == 0, exit_code
`,
    )

    const { stdout } = await execFileAsync('python3', [probePath, runnerPath, eventPath], { timeout: 10_000 })

    expect(stdout).toContain('market_session_closed_noop')
  })

  it('handles byte output from timed-out provider attempts', async () => {
    const manifest = await readFile(
      resolve(process.cwd(), '..', '..', 'argocd/applications/agents/torghut-market-context-agentprovider.yaml'),
      'utf8',
    )
    const runner = extractInputFileContent(manifest, '/root/.codex/market-context-provider-runner.py')
    const tempDir = await mkdtemp(resolve(tmpdir(), 'market-context-runner-'))
    const runnerPath = resolve(tempDir, 'market-context-provider-runner.py')
    const probePath = resolve(tempDir, 'probe.py')
    await writeFile(runnerPath, runner)
    await writeFile(
      probePath,
      `
import importlib.util
import subprocess
import sys
from pathlib import Path

runner_path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('runner', runner_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

def fake_run(*args, **kwargs):
  raise subprocess.TimeoutExpired(
    cmd=args[0],
    timeout=1,
    output=bytes([111, 117, 116, 255]),
    stderr=bytes([101, 114, 114, 255]),
  )

module.subprocess.run = fake_run
exit_code, failure_category, message = module._run_attempt(Path('/tmp/event.json'), 'codex', 'gpt-5.5', 1)
assert exit_code == 124, exit_code
assert failure_category == 'provider_attempt_timeout', failure_category
assert message == 'provider_attempt_timeout', message
`,
    )

    const { stderr, stdout } = await execFileAsync('python3', [probePath, runnerPath], { timeout: 10_000 })

    expect(stdout).toContain('out')
    expect(stderr).toContain('err')
  })

  it('classifies generated script syntax failures as provider-fallback eligible payload failures', async () => {
    const manifest = await readFile(
      resolve(process.cwd(), '..', '..', 'argocd/applications/agents/torghut-market-context-agentprovider.yaml'),
      'utf8',
    )
    const runner = extractInputFileContent(manifest, '/root/.codex/market-context-provider-runner.py')
    const tempDir = await mkdtemp(resolve(tmpdir(), 'market-context-runner-'))
    const runnerPath = resolve(tempDir, 'market-context-provider-runner.py')
    const probePath = resolve(tempDir, 'probe.py')
    await writeFile(runnerPath, runner)
    await writeFile(
      probePath,
      `
import importlib.util
import subprocess
import sys
from pathlib import Path

runner_path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('runner', runner_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

def fake_run(*args, **kwargs):
  return subprocess.CompletedProcess(
    args=args[0],
    returncode=1,
    stdout='',
    stderr='  File "<stdin>", line 689\\nSyntaxError: ( was never closed\\nCommand exited with status 1\\n',
  )

module.subprocess.run = fake_run
exit_code, failure_category, message = module._run_attempt(Path('/tmp/event.json'), 'codex', 'gpt-5.5', 1)
assert exit_code == 1, exit_code
assert failure_category == 'payload_validation_failure', failure_category
assert module._can_retry_with_next_provider(failure_category) is True
assert message == 'Command exited with status 1', message
`,
    )

    const { stderr } = await execFileAsync('python3', [probePath, runnerPath], { timeout: 10_000 })

    expect(stderr).toContain('SyntaxError')
  })
})
