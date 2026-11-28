export function connectionResourceDisplay(name: string, kind: string | undefined) {
  if (kind !== 'kubernetes.namespace') return { name, detail: '' }
  if (name === 'ofz')
    return { name: 'Ofz infrastructure', detail: 'Kubernetes namespace · ofz · Platform authorization service' }
  if (name === 'opencode')
    return { name: 'OpenCode infrastructure', detail: 'Kubernetes namespace · opencode · Development server' }
  return { name, detail: `Kubernetes namespace · ${name}` }
}
