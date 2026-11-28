import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { configureAgentsShellKubeconfig } from '../../../scripts/configure-agents-shell-kubeconfig'

const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-shell-kubeconfig-'))
  roots.push(root)
  writeFileSync(join(root, 'token'), 'fixture-token-do-not-copy')
  writeFileSync(join(root, 'ca.crt'), 'fixture-ca')
  writeFileSync(join(root, 'namespace'), 'agents\n')
  return { kubeconfigPath: join(root, 'config'), serviceAccountDirectory: root, server: 'https://10.96.0.1:443' }
}

const kubectlConfig = (kubeconfigPath: string, args: string[]) =>
  execFileSync('kubectl', ['--kubeconfig', kubeconfigPath, 'config', ...args], { encoding: 'utf8' }).trim()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('agents-shell Kubernetes context', () => {
  it('provides a real kubectl current context using the mounted identity without copying its token', () => {
    const input = fixture()
    expect(() => kubectlConfig(input.kubeconfigPath, ['current-context'])).toThrow()

    configureAgentsShellKubeconfig(input)

    expect(kubectlConfig(input.kubeconfigPath, ['current-context'])).toBe('in-cluster')
    expect(
      kubectlConfig(input.kubeconfigPath, ['view', '--minify', '-o', 'jsonpath={.contexts[0].context.namespace}']),
    ).toBe('agents')
    expect(kubectlConfig(input.kubeconfigPath, ['view', '--minify', '-o', 'jsonpath={.users[0].user.tokenFile}'])).toBe(
      join(input.serviceAccountDirectory, 'token'),
    )
    expect(readFileSync(input.kubeconfigPath, 'utf8')).not.toContain('fixture-token-do-not-copy')
    expect(statSync(input.kubeconfigPath).mode & 0o777).toBe(0o600)
  })

  it('regenerates the owned configuration on restart and keeps the token as a file reference', () => {
    const input = fixture()
    configureAgentsShellKubeconfig(input)
    writeFileSync(join(input.serviceAccountDirectory, 'namespace'), 'agents-test\n')
    writeFileSync(join(input.serviceAccountDirectory, 'token'), 'rotated-fixture-token')

    configureAgentsShellKubeconfig(input)

    expect(kubectlConfig(input.kubeconfigPath, ['current-context'])).toBe('in-cluster')
    expect(
      kubectlConfig(input.kubeconfigPath, ['view', '--minify', '-o', 'jsonpath={.contexts[0].context.namespace}']),
    ).toBe('agents-test')
    expect(readFileSync(input.kubeconfigPath, 'utf8')).not.toContain('rotated-fixture-token')
  })

  it('fails explicitly when the mounted identity is incomplete', () => {
    const input = fixture()
    rmSync(join(input.serviceAccountDirectory, 'token'))
    expect(() => configureAgentsShellKubeconfig(input)).toThrow('ENOENT')
  })
})
