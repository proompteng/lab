import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('Jangar Nix image contract', () => {
  it('bakes the Codex config and points runtime discovery at the baked home', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/jangar.nix'), 'utf8')
    const config = readFileSync(join(repoRoot, 'services/jangar/scripts/codex-config-container.toml'), 'utf8')

    expect(image).toContain('mkdir -p "$out/app/packages" "$out/app/services/jangar" "$out/root/.codex"')
    expect(image).toContain('cp ${codexConfig} "$out/root/.codex/config.toml"')
    expect(image).toContain('mcp_servers = builtins.removeAttrs codexConfigTemplate.mcp_servers [ "alpaca" ];')
    expect(image).toContain('"HOME=/root"')
    expect(image).toContain('"CODEX_HOME=/root/.codex"')
    expect(config).toContain('model = "gpt-6-astra"')
  })
})
