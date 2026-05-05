import { describe, expect, it } from 'bun:test'

import { __private } from '../deploy-service'

describe('agents deploy-service helpers', () => {
  it('drops Argo CD hook resources from direct kubectl apply manifests', () => {
    const rendered = `apiVersion: v1
kind: ConfigMap
metadata:
  name: agents-config
---
apiVersion: batch/v1
kind: Job
metadata:
  name: agents-smoke-cleanup
  annotations:
    argocd.argoproj.io/hook: PreSync
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: cleanup
          image: alpine/k8s:1.30.11
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agents
spec:
  template:
    spec:
      containers:
        - name: agents
          image: registry.example/agents@sha256:abc
`

    const filtered = __private.filterDirectApplyManifests(rendered)

    expect(filtered).toContain('kind: ConfigMap')
    expect(filtered).toContain('kind: Deployment')
    expect(filtered).not.toContain('kind: Job')
    expect(filtered).not.toContain('agents-smoke-cleanup')
    expect(filtered).not.toContain('argocd.argoproj.io/hook')
  })

  it('detects Argo CD hook manifests by annotation', () => {
    expect(
      __private.isArgoHookManifest({
        metadata: {
          annotations: {
            'argocd.argoproj.io/hook': 'PostSync',
          },
        },
      }),
    ).toBeTrue()

    expect(
      __private.isArgoHookManifest({
        metadata: {
          annotations: {
            'helm.sh/hook': 'test',
          },
        },
      }),
    ).toBeFalse()
  })
})
