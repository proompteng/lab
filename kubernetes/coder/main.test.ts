import { describe, expect, test } from 'bun:test'

const template = await Bun.file(new URL('./main.tf', import.meta.url)).text()
const bootstrapStart = template.indexOf('resource "coder_script" "bootstrap_tools"')
const bootstrapEnd = template.indexOf('\n  EOT', bootstrapStart)
const bootstrap = template.slice(bootstrapStart, bootstrapEnd)

describe('Coder Bun bootstrap', () => {
  test('upgrades existing runtimes that do not match the pinned version', () => {
    expect(bootstrap).toContain('CURRENT_BUN_VERSION=$(bun --version 2>/dev/null || true)')
    expect(bootstrap).toContain('if [ "$CURRENT_BUN_VERSION" != "$BOOTSTRAP_BUN_VERSION" ]; then')
    expect(bootstrap).toContain('bash -s -- "bun-v$BOOTSTRAP_BUN_VERSION"')
  })

  test('fails before workspace setup when installation does not produce the pinned version', () => {
    const verification = 'if [ "$BUN_VERSION" != "$BOOTSTRAP_BUN_VERSION" ]; then'
    const workspaceInstall = 'install_workspace_dependencies()'

    expect(bootstrap).toContain(verification)
    expect(bootstrap.indexOf(verification)).toBeLessThan(bootstrap.indexOf(workspaceInstall))
  })
})
