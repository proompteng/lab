import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

const loadManifest = async (relativePath: string) => Bun.file(path.join(repoRoot, relativePath)).text()

describe('target argocd rbac manifests', () => {
  test('use cluster-scoped RBAC so overlay namespace transforms cannot relocate them', async () => {
    const manifests = await Promise.all([
      loadManifest('argocd/applications/symphony/target-argocd-role.yaml'),
      loadManifest('argocd/applications/symphony/target-argocd-rolebinding.yaml'),
      loadManifest('argocd/applications/symphony-jangar/target-argocd-role.yaml'),
      loadManifest('argocd/applications/symphony-jangar/target-argocd-rolebinding.yaml'),
      loadManifest('argocd/applications/symphony-torghut/target-argocd-role.yaml'),
      loadManifest('argocd/applications/symphony-torghut/target-argocd-rolebinding.yaml'),
    ])

    expect(manifests[0]).toContain('kind: ClusterRole')
    expect(manifests[1]).toContain('kind: ClusterRoleBinding')
    expect(manifests[2]).toContain('kind: ClusterRole')
    expect(manifests[3]).toContain('kind: ClusterRoleBinding')
    expect(manifests[4]).toContain('kind: ClusterRole')
    expect(manifests[5]).toContain('kind: ClusterRoleBinding')

    for (const manifest of manifests) {
      expect(manifest).not.toContain('namespace: argocd')
    }
  })
})
