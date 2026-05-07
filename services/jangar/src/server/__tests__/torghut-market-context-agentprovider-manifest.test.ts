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
  it('uses a bearer token for lifecycle start/progress requests', async () => {
    const manifest = await readFile(
      resolve(process.cwd(), '..', '..', 'argocd/applications/agents/torghut-market-context-agentprovider.yaml'),
      'utf8',
    )

    expect(manifest).toContain("DEFAULT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'")
    expect(manifest).toContain('token = _load_bearer_token()')
    expect(manifest).toContain("headers['authorization'] = f'Bearer {token}'")
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
})
