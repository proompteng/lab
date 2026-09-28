import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'bun:test'
import { parseAllDocuments } from 'yaml'

type Manifest = {
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
  }
  roleRef?: unknown
  rules?: unknown
  subjects?: unknown
}

const readYamlObjects = (path: string) =>
  parseAllDocuments(readFileSync(resolve(process.cwd(), path), 'utf8')).map((document) => document.toJSON() as Manifest)

describe('jangar post-deploy verifier RBAC', () => {
  const manifests = readYamlObjects('argocd/applications/jangar/post-deploy-verifier-rbac.yaml')

  it('keeps the Jangar namespace service proxy grant for local service checks', () => {
    const role = manifests.find(
      (manifest) =>
        manifest?.kind === 'Role' &&
        manifest?.metadata?.name === 'post-deploy-verifier' &&
        manifest?.metadata?.namespace === 'jangar',
    )

    expect(role?.rules).toContainEqual({
      apiGroups: [''],
      resources: ['services/proxy'],
      verbs: ['get'],
    })
  })

  it('grants the ARC runner access to the Agents control-plane service proxy used by deployment verification', () => {
    const clusterRole = manifests.find(
      (manifest) =>
        manifest?.kind === 'ClusterRole' && manifest?.metadata?.name === 'jangar-post-deploy-verifier-agents-proxy',
    )
    const clusterRoleBinding = manifests.find(
      (manifest) =>
        manifest?.kind === 'ClusterRoleBinding' &&
        manifest?.metadata?.name === 'jangar-post-deploy-verifier-agents-proxy',
    )

    expect(clusterRole?.rules).toContainEqual({
      apiGroups: [''],
      resources: ['services/proxy'],
      resourceNames: ['agents', 'agents:80'],
      verbs: ['get'],
    })
    expect(clusterRoleBinding?.subjects).toContainEqual({
      kind: 'ServiceAccount',
      name: 'arc-arm64-gha-rs-kube-mode',
      namespace: 'arc',
    })
    expect(clusterRoleBinding?.roleRef).toEqual({
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: 'jangar-post-deploy-verifier-agents-proxy',
    })
  })
})
