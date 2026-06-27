import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  validateActiveSaigakMigrationContent,
  validateFiles,
  requiredTerms,
  forbiddenTerms,
} from './validate-flamingo-hard-migration'

async function mkfile(content: string): Promise<string> {
  const id = Math.random().toString(36).slice(2)
  const dir = join('/tmp', 'flamingo-test-' + id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'file.txt')
  await writeFile(path, content)
  return path
}

describe('validateFiles', () => {
  it('import safety: exports are defined without side effects', () => {
    expect(typeof validateFiles).toBe('function')
    expect(Array.isArray(requiredTerms)).toBe(true)
    expect(Array.isArray(forbiddenTerms)).toBe(true)
    expect(requiredTerms.length).toBeGreaterThan(0)
    expect(forbiddenTerms.length).toBeGreaterThan(0)
  })

  it('detects missing required term', async () => {
    const path = await mkfile('some content without any terms')
    const failures = await validateFiles([path], requiredTerms, forbiddenTerms)
    expect(failures).toContain('active Flamingo surfaces do not contain required term "unsloth/Qwen3.6-35B-A3B-NVFP4"')
    expect(failures.length).toBeGreaterThan(0)
  })

  it('detects stale forbidden term', async () => {
    const path = await mkfile('contains Qwen/Qwen3-Coder-Next-FP8 here')
    const failures = await validateFiles([path], requiredTerms, forbiddenTerms)
    expect(failures).toContain(`${path}: still contains forbidden Flamingo migration term "Qwen/Qwen3-Coder-Next-FP8"`)
  })

  it('passes when all terms are satisfied', async () => {
    const path = await mkfile(requiredTerms.join('\n'))
    const failures = await validateFiles([path], requiredTerms, forbiddenTerms)
    expect(failures).toEqual([])
  })

  it('detects multiple forbidden terms in one file', async () => {
    const path = await mkfile([forbiddenTerms[0], forbiddenTerms[1], forbiddenTerms[2]].join('\n'))
    const failures = await validateFiles([path], requiredTerms, forbiddenTerms)
    // 3 forbidden + 3 missing required (qwen3 is substring of qwen3-coder-flamingo)
    expect(failures.length).toBe(6)
    expect(failures).toContain(`${path}: still contains forbidden Flamingo migration term "${forbiddenTerms[0]}"`)
    expect(failures).toContain(`${path}: still contains forbidden Flamingo migration term "${forbiddenTerms[1]}"`)
    expect(failures).toContain(`${path}: still contains forbidden Flamingo migration term "${forbiddenTerms[2]}"`)
  })

  it('reports all missing required terms', async () => {
    const path = await mkfile(requiredTerms[0] + '\n' + forbiddenTerms[0])
    const failures = await validateFiles([path], requiredTerms, forbiddenTerms)
    expect(failures).toContain('active Flamingo surfaces do not contain required term "qwen36-flamingo"')
    expect(failures).toContain('active Flamingo surfaces do not contain required term "qwen3"')
    expect(failures).toContain('active Flamingo surfaces do not contain required term "qwen3_coder"')
    expect(failures).toContain(`${path}: still contains forbidden Flamingo migration term "Qwen/Qwen3-Coder-Next-FP8"`)
    expect(failures.length).toBe(4)
  })

  it('detects Saigak completion routing in active consumers', () => {
    const failures = validateActiveSaigakMigrationContent([
      {
        path: 'argocd/applications/bumba/deployment.yaml',
        content: [
          '- name: OPENAI_API_BASE_URL',
          '  value: http://saigak.saigak.svc.cluster.local:11434/v1',
          '- name: OPENAI_COMPLETION_MODEL',
          '  value: qwen3-main-saigak:30b-a3b',
        ].join('\n'),
      },
    ])

    expect(failures).toContain(
      'argocd/applications/bumba/deployment.yaml: active completion base URL must point to Flamingo, not Saigak',
    )
    expect(failures).toContain(
      'argocd/applications/bumba/deployment.yaml: active completion surface still references disabled Saigak model "qwen3-main-saigak:30b-a3b"',
    )
  })

  it('detects OpenWebUI Saigak chat backend exposure', () => {
    const failures = validateActiveSaigakMigrationContent([
      {
        path: 'argocd/applications/jangar/openwebui-values.yaml',
        content: ['ENABLE_OLLAMA_API: "true"', 'OLLAMA_BASE_URLS=http://saigak.saigak.svc.cluster.local:11434'].join(
          '\n',
        ),
      },
    ])

    expect(failures).toContain(
      'argocd/applications/jangar/openwebui-values.yaml: OpenWebUI must not expose Saigak as a chat backend via "OLLAMA_BASE_URLS"',
    )
    expect(failures.some((failure) => failure.includes('ENABLE_OLLAMA_API: "true"'))).toBe(true)
  })

  it('allows Saigak to remove old completion models without provisioning them', () => {
    const failures = validateActiveSaigakMigrationContent([
      {
        path: 'argocd/applications/saigak/statefulset.yaml',
        content: [
          'kubernetes.io/hostname: talos-192-168-1-85',
          'ollama pull qwen3-embedding:8b',
          'ollama create qwen3-embedding-saigak:8b -f /config/qwen3-embedding-8b.modelfile',
          'for model in qwen3-main-saigak:30b-a3b qwen3:30b-a3b; do',
          '  ollama rm "$model"',
          'done',
        ].join('\n'),
      },
    ])

    expect(failures).toEqual([])
  })

  it('detects Saigak scheduling on the Blackwell node', () => {
    const failures = validateActiveSaigakMigrationContent([
      {
        path: 'argocd/applications/saigak/statefulset.yaml',
        content: 'kubernetes.io/hostname: turin\n',
      },
    ])

    expect(failures).toContain(
      'argocd/applications/saigak/statefulset.yaml: Saigak must stay on the Altra RTX 3090 path, found "kubernetes.io/hostname: turin"',
    )
  })

  it('detects active KubeVirt 3090 passthrough desired state', () => {
    const failures = validateActiveSaigakMigrationContent([
      {
        path: 'argocd/applications/kubevirt/kustomization.yaml',
        content: 'permittedHostDevices:\n  pciHostDevices:\n    - resourceName: nvidia.com/GA102_GEFORCE_RTX_3090\n',
      },
    ])

    expect(failures).toContain(
      'argocd/applications/kubevirt/kustomization.yaml: 3090 passthrough must not remain active via "nvidia.com/GA102_GEFORCE_RTX_3090"',
    )
    expect(failures).toContain(
      'argocd/applications/kubevirt/kustomization.yaml: 3090 passthrough must not remain active via "permittedHostDevices"',
    )
  })
})
