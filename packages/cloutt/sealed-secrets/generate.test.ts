import { afterEach, describe, expect, it, mock } from 'bun:test'
import { load } from 'js-yaml'
import { generatePlainSecret, sealSecret } from './generate'

// Define interfaces for type safety
interface PlainSecret {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace: string
  }
  type: string
  data: Record<string, string>
}

// Global mocks
const execSyncMock = mock(() => Buffer.from('mocked-output'))

// Mock execSync
mock.module('node:child_process', () => ({
  execSync: execSyncMock,
}))

describe('Plain Secret Generation', () => {
  it('should generate valid plain secret yaml', () => {
    const input = {
      name: 'test-secret',
      namespace: 'default',
      data: {
        key: 'value',
      },
    }

    const yaml = generatePlainSecret(input)
    const parsed = load(yaml) as PlainSecret

    expect(parsed.apiVersion).toBe('v1')
    expect(parsed.kind).toBe('Secret')
    expect(parsed.metadata.name).toBe(input.name)
    expect(parsed.metadata.namespace).toBe(input.namespace)
    expect(parsed.type).toBe('Opaque')
    expect(parsed.data.key).toBe(Buffer.from('value').toString('base64'))
  })

  it('should handle multiple data entries', () => {
    const input = {
      name: 'multi-secret',
      namespace: 'test',
      data: {
        username: 'admin',
        password: 'secret123',
      },
    }

    const yaml = generatePlainSecret(input)
    const parsed = load(yaml) as PlainSecret

    expect(parsed.data.username).toBe(Buffer.from('admin').toString('base64'))
    expect(parsed.data.password).toBe(Buffer.from('secret123').toString('base64'))
  })
})

describe('Sealed Secret Generation', () => {
  afterEach(() => {
    // Reset mocks after each test
    execSyncMock.mockClear()
  })

  it('should call kubeseal with correct parameters', () => {
    const plainSecretYaml = 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: test\n'
    const sealedSecretOutput = 'apiVersion: bitnami.com/v1alpha1\nkind: SealedSecret\n'

    execSyncMock.mockImplementationOnce(() => Buffer.from(sealedSecretOutput))

    sealSecret(plainSecretYaml, 'test-controller', 'test-namespace')

    expect(execSyncMock).toHaveBeenCalled()
    const cmd = String(execSyncMock.mock.calls[0]?.[0])
    expect(cmd).toContain('--controller-name=test-controller')
    expect(cmd).toContain('--controller-namespace=test-namespace')
  })

  it('should use default controller name and namespace when not specified', () => {
    execSyncMock.mockImplementationOnce(() => Buffer.from('sealed-output'))

    sealSecret('plain-secret')

    expect(execSyncMock).toHaveBeenCalled()
    const cmdArgs = String(execSyncMock.mock.calls[0]?.[0])
    expect(cmdArgs).toContain('--controller-name=sealed-secrets-controller')
    expect(cmdArgs).toContain('--controller-namespace=kube-system')
  })

  it('should throw an error when kubeseal fails', () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('kubeseal failed')
    })

    expect(() => {
      sealSecret('plain-secret')
    }).toThrow('kubeseal command failed')
  })

  it('should handle end-to-end secret sealing process', () => {
    execSyncMock.mockImplementationOnce(() => Buffer.from('sealed-secret-yaml'))

    const input = {
      name: 'test-secret',
      namespace: 'default',
      data: { key: 'value' },
    }

    const plainSecretYaml = generatePlainSecret(input)
    const sealedSecretYaml = sealSecret(plainSecretYaml)

    expect(sealedSecretYaml).toBe('sealed-secret-yaml')
  })
})
