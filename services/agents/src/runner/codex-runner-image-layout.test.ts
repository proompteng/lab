import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { PSTACK_SKILLS_PATH } from './pstack'
import { AGENT_RUNNER_SCHEMA_VERSION } from './spec'

const image = () => readFileSync(new URL('../../../../nix/images/agents.nix', import.meta.url), 'utf8')
const tools = () => readFileSync(new URL('../../../../nix/images/agentrun-tools.nix', import.meta.url), 'utf8')
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const execFileAsync = promisify(execFile)

describe('Agents Codex runner image layout', () => {
  it('builds the production runner with the complete Nix toolchain', () => {
    const content = image()
    expect(content).toContain('runnerTools.contents ++ [')
    expect(content).toContain('antigravityCli = import ./antigravity-cli.nix')
    expect(content).toContain('AGY_CLI_DISABLE_AUTO_UPDATE=true')
    expect(content).toContain('agentsShellInterpreterCompat')
    expect(content).toContain('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1')
    expect(content).toContain('runner-acceptance.sh')
    expect(tools()).toContain('rustc cargo rustfmt clippy')
    expect(tools()).toContain('autoPatchelfHook')
    expect(tools()).toContain('doInstallCheck = true')
  })

  it('includes the pinned pstack bundle in the runner outside the mounted Codex home', () => {
    const content = image()
    const runnerContents = content.match(/runnerRuntimeContents\s*=\s*runnerTools\.contents\s*\+\+\s*\[([^\]]*)\]/)?.[1]
    const provider = readFileSync(
      new URL('../../../../argocd/applications/agents/codex-agentprovider.yaml', import.meta.url),
      'utf8',
    )

    expect(runnerContents?.trim().split(/\s+/)).toContain('pstackBundle')
    expect(content).toContain('extraContents = runnerRuntimeContents')
    expect(content).toContain(`$out${PSTACK_SKILLS_PATH}/poteto-mode/SKILL.md`)
    expect(provider).toContain("AGENTS_RUNNER_PSTACK_ENABLED: 'true'")
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

  it('bundles a runnable CLI without runtime-resolving Effect or source TS modules', async () => {
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
      expect(bundle).toContain('// services/agents/src/runner/pstack.ts')
      expect(bundle).toContain('// services/agents/src/runner/agy-cli.ts')
      expect(bundle).not.toMatch(/from ["']effect["']/)
      expect(bundle).not.toMatch(/require\(["']effect["']\)/)
      expect(bundle).not.toMatch(/import\(["']effect["']\)/)
      expect(bundle).not.toMatch(/from ["']\.\.\/\.\.\/src\/runner\/codex-app-server["']/)

      const specPath = join(outDir, 'spec.json')
      const options = { cwd: outDir, env: { PATH: process.env.PATH, AGENTS_RUNNER_PSTACK_ENABLED: 'invalid' } }
      await writeFile(
        specPath,
        JSON.stringify({
          schemaVersion: AGENT_RUNNER_SCHEMA_VERSION,
          provider: 'exec-smoke',
          adapter: { type: 'exec', exec: { binary: process.execPath, argsTemplate: ['-e', 'process.exit(7)'] } },
        }),
      )
      await expect(execFileAsync('bun', [outfile, specPath], options)).rejects.toMatchObject({ code: 7 })

      await writeFile(specPath, '{')
      await expect(execFileAsync('bun', [outfile, specPath], options)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Failed to parse agent-runner spec'),
      })

      // Only the Codex adapter must validate pstack before starting.
      await writeFile(
        specPath,
        JSON.stringify({
          schemaVersion: AGENT_RUNNER_SCHEMA_VERSION,
          provider: 'pstack-smoke',
          adapter: { type: 'codex-app-server', codex: {} },
        }),
      )
      await expect(execFileAsync('bun', [outfile, specPath], options)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('AGENTS_RUNNER_PSTACK_ENABLED must be true or false'),
      })
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})
