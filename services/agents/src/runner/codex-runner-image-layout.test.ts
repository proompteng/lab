import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const image = () => readFileSync(new URL('../../../../nix/images/agents.nix', import.meta.url), 'utf8')
const tools = () => readFileSync(new URL('../../../../nix/images/agentrun-tools.nix', import.meta.url), 'utf8')
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const execFileAsync = promisify(execFile)

describe('Agents Codex runner image layout', () => {
  it('builds the production runner with the complete Nix toolchain', () => {
    const content = image()
    expect(content).toContain('runnerTools.contents ++ [')
    expect(content).toContain('agentsShellInterpreterCompat')
    expect(content).toContain('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1')
    expect(content).toContain('runner-acceptance.sh')
    expect(tools()).toContain('rustc cargo rustfmt clippy')
    expect(tools()).toContain('autoPatchelfHook')
    expect(tools()).toContain('doInstallCheck = true')
  })

  it('keeps the browser aligned with the landing Playwright dependency', () => {
    const landing = readFileSync(new URL('../../../../apps/landing/package.json', import.meta.url), 'utf8')
    const version = /"@playwright\/test":\s*"([^"]+)"/.exec(landing)?.[1]
    expect(version).toBeTruthy()
    expect(tools()).toContain(`playwrightVersion = "${version}"`)
    expect(tools()).toContain('chromium_headless_shell-1217')
    expect(tools()).toContain('147.0.7727.15')
  })

  it('uses the same SpiceDB version as production fixtures', () => {
    const deployment = readFileSync(
      new URL('../../../../argocd/applications/ofz/spicedb-cluster.yaml', import.meta.url),
      'utf8',
    )
    const version = /spicedb:v([^@]+)@/.exec(deployment)?.[1]
    expect(version).toBeTruthy()
    expect(tools()).toContain(`version = "${version}"`)
  })

  it('bundles the runner without runtime-resolving Effect or source TS modules', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'agents-runner-bundle-'))
    const outfile = join(outDir, 'agent-runner.js')

    try {
      const { stdout, stderr } = await execFileAsync(
        'bun',
        ['build', 'services/agents/scripts/codex/agent-runner.ts', '--target', 'bun', '--outfile', outfile],
        {
          cwd: repoRoot,
          maxBuffer: 10 * 1024 * 1024,
        },
      )

      expect(`${stderr}\n${stdout}`).toContain('agent-runner.js')

      const bundle = await readFile(outfile, 'utf8')
      expect(bundle).toContain('// services/agents/src/runner/codex-app-server.ts')
      expect(bundle).not.toMatch(/from ["']effect["']/)
      expect(bundle).not.toMatch(/require\(["']effect["']\)/)
      expect(bundle).not.toMatch(/import\(["']effect["']\)/)
      expect(bundle).not.toMatch(/from ["']\.\.\/\.\.\/src\/runner\/codex-app-server["']/)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})
