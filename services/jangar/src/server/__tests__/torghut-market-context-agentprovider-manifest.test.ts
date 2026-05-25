import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const torghutAgentsDomainManifestPath = (fileName: string) =>
  resolve(process.cwd(), '..', '..', 'argocd/applications/torghut/agents-domain', fileName)

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
  it('does not declare fundamentals market-context AgentRun resources', async () => {
    const manifest = await readFile(torghutAgentsDomainManifestPath('torghut-market-context-batch.yaml'), 'utf8')
    const agentRunsManifest = await readFile(torghutAgentsDomainManifestPath('torghut-agentruns.yaml'), 'utf8')
    const kustomization = await readFile(torghutAgentsDomainManifestPath('kustomization.yaml'), 'utf8')

    expect(manifest).not.toMatch(/torghut-market-context-fundamentals/)
    expect(agentRunsManifest).not.toMatch(/torghut-market-context-fundamentals/)
    expect(kustomization).not.toContain('torghut-fundamentals-agent.yaml')
    expect(kustomization).not.toContain('torghut-fundamentals-agent-system-prompt-configmap.yaml')
  })

  it('does not schedule news market-context jobs', async () => {
    const manifest = await readFile(torghutAgentsDomainManifestPath('torghut-market-context-batch.yaml'), 'utf8')

    expect(manifest).not.toMatch(/^  name: torghut-market-context-news-preopen-probe-template$/m)
    expect(manifest).not.toMatch(/^  name: torghut-market-context-news-batch-template$/m)
    expect(manifest).not.toMatch(/^  name: torghut-market-context-news-preopen-probe$/m)
    expect(manifest).not.toMatch(/^  name: torghut-market-context-news-batch$/m)
  })

  it('uses a bearer token for lifecycle start/progress requests', async () => {
    const manifest = await readFile(
      torghutAgentsDomainManifestPath('torghut-market-context-agentprovider.yaml'),
      'utf8',
    )

    expect(manifest).toContain("DEFAULT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'")
    expect(manifest).toContain('token = _load_token(args.token_path)')
    expect(manifest).toContain("headers['authorization'] = f'Bearer {token}'")
  })

  it('mounts the market-context lifecycle helper scripts at the instructed skill path', async () => {
    const manifest = await readFile(
      torghutAgentsDomainManifestPath('torghut-market-context-agentprovider.yaml'),
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

  it('uses the Codex app-server adapter instead of the legacy market-context runner wrapper', async () => {
    const manifest = await readFile(
      torghutAgentsDomainManifestPath('torghut-market-context-agentprovider.yaml'),
      'utf8',
    )

    expect(manifest).toContain('type: codex-app-server')
    expect(manifest).toContain('model: gpt-5.5')
    expect(manifest).toContain('effort: xhigh')
    expect(manifest).toContain('cwd: /workspace/lab')
    expect(manifest).toContain('web_search: live')
    expect(manifest).toContain('CODEX_MARKET_CONTEXT_PREFLIGHT_TIMEOUT_SECONDS: "10"')
    expect(manifest).not.toContain('/root/.codex/market-context-provider-runner.py')
    expect(manifest).not.toContain('def _write_process_output(stream, output) -> None:')
    expect(manifest).not.toContain('codex-implement')
  })

  it('hydrates market-context issue numbers before Codex app-server execution', async () => {
    const manifest = await readFile(
      torghutAgentsDomainManifestPath('torghut-market-context-agentprovider.yaml'),
      'utf8',
    )
    const helper = extractInputFileContent(manifest, '/root/.codex/ensure-market-context-issue-number.py')
    const tempDir = await mkdtemp(resolve(tmpdir(), 'market-context-helper-'))
    const helperPath = resolve(tempDir, 'ensure-market-context-issue-number.py')
    const eventPath = resolve(tempDir, 'event.json')
    await writeFile(helperPath, helper)
    await writeFile(
      eventPath,
      JSON.stringify({
        parameters: {
          repository: 'proompteng/lab',
          domain: 'news',
          symbol: 'AMD',
          requestId: 'market-context-news-amd-smoke',
          stage: 'market-context',
        },
        prompt: 'Collect market context for ${symbol}',
        implementation: {
          text: 'Use request ${issueNumber} for ${domain}',
        },
      }),
    )

    await execFileAsync('python3', ['-m', 'py_compile', helperPath], { timeout: 10_000 })
    await execFileAsync('python3', [helperPath, eventPath], { timeout: 10_000 })

    const payload = JSON.parse(await readFile(eventPath, 'utf8')) as Record<string, unknown>
    expect(payload.issueNumber).toMatch(/^\d+$/)
    expect(payload.issue_number).toBe(payload.issueNumber)
    expect(payload.prompt).toBe('Collect market context for AMD')
    expect(payload.implementation).toMatchObject({
      text: `Use request ${payload.issueNumber} for news`,
    })
  })
})
