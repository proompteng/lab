import { afterEach, describe, expect, it } from 'bun:test'
import { buildKubectlArgs, KubectlError, resetKubectlRunner, runKubectlJson, setKubectlRunner } from '../kube/kubectl'

afterEach(() => {
  resetKubectlRunner()
})

describe('kubectl helpers', () => {
  it('builds kubectl args with kubeconfig, context, and namespace', () => {
    const args = buildKubectlArgs({ kubeconfig: '/tmp/kube', context: 'dev', namespace: 'agents' })
    expect(args).toEqual(['--kubeconfig', '/tmp/kube', '--context', 'dev', '-n', 'agents'])
  })

  it('parses JSON output', async () => {
    setKubectlRunner(async () => ({ stdout: '{"ok":true}', stderr: '', exitCode: 0 }))
    const result = await runKubectlJson<{ ok: boolean }>(['get', 'ns', 'agents', '-o', 'json'], {})
    expect(result.ok).toBe(true)
  })

  it('throws a KubectlError on non-zero exit', async () => {
    setKubectlRunner(async () => ({
      stdout: '',
      stderr: 'Error from server (NotFound): namespaces "agents" not found',
      exitCode: 1,
    }))
    await expect(runKubectlJson(['get', 'ns', 'agents', '-o', 'json'], {})).rejects.toThrow(KubectlError)
  })
})
