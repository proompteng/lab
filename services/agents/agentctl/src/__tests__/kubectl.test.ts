import { afterEach, describe, expect, it } from 'bun:test'
import { createKubectlBackend, podLogArgs } from '../kube/backend'
import type { KubectlOptions } from '../kube/kubectl'
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

describe('typed fleet reads', () => {
  const backend = createKubectlBackend({ kubeconfig: '/tmp/kube', context: 'galactic-test' })

  it('uses the right API resources, namespace, and selectors', async () => {
    const requests: Array<{ args: string[]; options: KubectlOptions }> = []
    setKubectlRunner(async (args, options) => {
      requests.push({ args, options })
      const item = {
        metadata: { name: 'sample' },
        ...(args[1] === 'events' ? { involvedObject: { kind: 'AgentRun', name: 'demo', uid: 'run-uid' } } : {}),
      }
      return {
        stdout: JSON.stringify(args[1].includes('/') ? item : { items: [item] }),
        stderr: '',
        exitCode: 0,
      }
    })
    const signal = new AbortController().signal
    expect((await backend.listJobs('fixture', 'app=runner', signal))[0]?.metadata.name).toBe('sample')
    await backend.listPods('fixture', 'app=runner')
    await backend.getConfigMap('fixture', 'demo-spec', signal)
    await backend.listNodes()
    await backend.listLeases('leader-ns')
    const events = await backend.listEvents('fixture', 'involvedObject.uid=run-uid')
    expect(events[0]?.involvedObject.uid).toBe('run-uid')
    await backend.getCnpgCluster('fixture', 'agents-db-next')
    expect(requests.map(({ args, options }) => [...buildKubectlArgs(options), ...args])).toEqual(
      [
        ['-n', 'fixture', 'get', 'jobs.batch', '-o', 'json', '-l', 'app=runner'],
        ['-n', 'fixture', 'get', 'pods', '-o', 'json', '-l', 'app=runner'],
        ['-n', 'fixture', 'get', 'configmap/demo-spec', '-o', 'json', '--ignore-not-found'],
        ['get', 'nodes', '-o', 'json'],
        ['-n', 'leader-ns', 'get', 'leases.coordination.k8s.io', '-o', 'json'],
        ['-n', 'fixture', 'get', 'events', '-o', 'json', '--field-selector', 'involvedObject.uid=run-uid'],
        ['-n', 'fixture', 'get', 'clusters.postgresql.cnpg.io/agents-db-next', '-o', 'json', '--ignore-not-found'],
      ].map((args) => ['--kubeconfig', '/tmp/kube', '--context', 'galactic-test', ...args]),
    )
    expect(requests[0]?.options.signal).toBe(signal)
    expect(requests[2]?.options.signal).toBe(signal)
  })

  it('distinguishes absent optional resources from API errors', async () => {
    setKubectlRunner(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    expect(await backend.getConfigMap('agents', 'demo-spec')).toBeNull()
    expect(await backend.getCnpgCluster('agents', 'agents-db-next')).toBeNull()

    setKubectlRunner(async () => ({
      stdout: '',
      stderr: 'error: the server doesn\'t have a resource type "clusters"',
      exitCode: 1,
    }))
    expect(await backend.getCnpgCluster('agents', 'agents-db-next')).toBeNull()

    setKubectlRunner(async () => ({ stdout: '', stderr: 'Error from server (Forbidden)', exitCode: 1 }))
    await expect(backend.getCnpgCluster('agents', 'agents-db-next')).rejects.toThrow('Forbidden')
    await expect(backend.getConfigMap('agents', 'demo-spec')).rejects.toThrow('Forbidden')
  })

  it('rejects malformed reads instead of showing empty or exposing the payload', async () => {
    setKubectlRunner(async () => ({ stdout: '{"items":{"notAList":true}}', stderr: '', exitCode: 0 }))
    await expect(backend.listJobs('agents')).rejects.toThrow('Invalid Kubernetes response for jobs.batch')
    setKubectlRunner(async () => ({ stdout: '{"data":{"run.json":"unrendered-data"}', stderr: '', exitCode: 0 }))
    await expect(backend.getConfigMap('agents', 'demo-spec')).rejects.toThrow('returned invalid JSON')
  })

  it('builds pod log arguments including zero-tail and previous', () => {
    expect(
      podLogArgs('runner', {
        follow: true,
        tail: 0,
        since: '10m',
        timestamps: true,
        previous: true,
        container: 'agent-runner',
      }),
    ).toEqual([
      'logs',
      'pod/runner',
      '-c',
      'agent-runner',
      '-f',
      '--tail=0',
      '--since=10m',
      '--timestamps',
      '--previous',
    ])
  })
})
