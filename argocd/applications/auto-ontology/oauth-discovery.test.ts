import { beforeAll, expect, test } from 'bun:test'

const issuer = new URL('https://auto-ontology.ide-newton.ts.net/api/auth')
const mcpUrl = new URL('https://auto-ontology-mcp.ide-newton.ts.net/mcp')
const metadataPath = '/.well-known/oauth-authorization-server'
const discoveryPath = `${metadataPath}${issuer.pathname}`
const proxyName = 'auto-ontology-oauth-discovery'

type Resource = { kind: string; metadata: { name: string } }
type ServiceBackend = { service: { name: string; port: { number: number } } }
type Ingress = Resource & {
  spec: {
    ingressClassName: string
    tls: { hosts: string[] }[]
    rules: { host: string; http: { paths: { path: string; pathType: string; backend: ServiceBackend }[] } }[]
  }
}
type Workload = Resource & {
  spec: {
    template: {
      metadata: { labels: Record<string, string> }
      spec: {
        automountServiceAccountToken?: boolean
        containers: {
          name: string
          image: string
          command?: string[]
          args?: string[]
          env?: { name: string; value?: string }[]
          readinessProbe?: { httpGet?: { path: string; port: string } }
          volumeMounts?: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[]
        }[]
        volumes?: { name: string; configMap?: { name: string } }[]
      }
    }
  }
}
type Service = Resource & {
  spec: { ports: { port: number; targetPort: string }[]; selector: Record<string, string> }
}
type WithInitContainers = {
  spec: { template: { spec: { initContainers: { name: string; image: string; args?: string[] }[] } } }
}

let manifests: Resource[]
beforeAll(() => {
  const render = Bun.spawnSync(['kustomize', 'build', '--enable-helm', '.'], {
    cwd: import.meta.dir,
    stderr: 'inherit',
    timeout: 45_000,
  })
  if (!render.success) throw new Error('Could not render Auto Ontology; use Kustomize with Helm 3')
  manifests = Bun.YAML.parse(render.stdout.toString()) as Resource[]
})

function resource<T extends Resource>(kind: string, name: string): T {
  const manifest = manifests.find((item) => item.kind === kind && item.metadata.name === name)
  if (!manifest) throw new Error(`Missing ${kind}/${name} in the Auto Ontology render`)
  return manifest as T
}

function routes(name: string, host: string) {
  const { spec } = resource<Ingress>('Ingress', name)
  expect(spec.ingressClassName).toBe('tailscale')
  expect(spec.tls).toEqual([{ hosts: [host] }])
  expect(spec.rules.map((rule) => rule.host)).toEqual([host])
  return spec.rules[0].http.paths
}

const prefix = (path: string, name: string, number: number) => ({
  path,
  pathType: 'Prefix',
  backend: { service: { name, port: { number } } },
})

test('the RFC 8414 path for the advertised issuer is routed on the web host without moving existing routes', () => {
  const frontend = resource<Workload>('Deployment', 'frontend').spec.template.spec.containers[0]
  expect(frontend.env?.find((entry) => entry.name === 'APP_URL')?.value).toBe(issuer.origin)

  const mcp = resource<Workload>('Deployment', 'auto-ontology-mcp').spec.template.spec.containers[0]
  const advertisedOrigin = mcp.env?.find((entry) => entry.name === 'AUTO_ONTOLOGY_API_URL')?.value
  expect(`${advertisedOrigin}/api/auth`).toBe(issuer.href)
  expect(mcp.args?.join('\n')).toContain('auth.authorization_servers = [AnyHttpUrl(f"{settings.api_url}/api/auth")]')

  expect(routes('auto-ontology-tailscale', issuer.hostname)).toEqual([
    prefix(discoveryPath, proxyName, 8080),
    prefix('/', 'frontend', 3000),
  ])
  expect(routes('auto-ontology-mcp-tailscale', mcpUrl.hostname)).toEqual([prefix('/', 'auto-ontology-mcp', 3003)])
})

test('only the exact discovery path reaches the existing metadata handler without forwarding credentials', () => {
  expect(manifests.filter(({ kind }) => kind === 'Namespace' || kind === 'Secret').map(({ kind }) => kind)).toEqual([])

  const { spec } = resource<Service>('Service', proxyName)
  expect(spec.ports).toMatchObject([{ port: 8080, targetPort: 'http' }])
  const { template } = resource<Workload>('Deployment', proxyName).spec
  expect(template.metadata.labels).toMatchObject(spec.selector)
  expect(template.spec.automountServiceAccountToken).toBe(false)
  const [proxy] = template.spec.containers
  expect(proxy.env?.map(({ name }) => name)).toBeUndefined()
  expect(Object.hasOwn(proxy, 'envFrom')).toBe(false)
  expect(proxy.readinessProbe?.httpGet).toEqual({ path: discoveryPath, port: 'http' })
  expect(proxy.volumeMounts).toEqual([{ name: 'config', mountPath: '/usr/local/etc/haproxy', readOnly: true }])
  const configName = template.spec.volumes?.find((volume) => volume.name === 'config')?.configMap?.name
  if (!configName) throw new Error('The discovery proxy is missing its configuration volume')
  expect(template.spec.volumes).toEqual([{ name: 'config', configMap: { name: configName } }])

  const config = resource<Resource & { data: Record<string, string> }>('ConfigMap', configName).data['haproxy.cfg']
  const directives = config.split('\n').map((line) => line.trim())
  expect(directives).toContain(`http-request return status 404 unless { path ${discoveryPath} }`)
  expect(directives).toContain('http-request return status 405 hdr Allow "GET, HEAD" unless { method GET HEAD }')
  expect(directives).toContain('http-request del-header . -m reg')
  expect(directives).toContain(`http-request set-header Host ${issuer.hostname}`)
  expect(directives).toContain('http-request set-header X-Forwarded-Proto https')
  expect(directives).toContain(`http-request set-uri ${metadataPath}`)
  expect(directives).toContain('default_backend frontend')
  expect(directives.filter((line) => line.startsWith('server '))).toEqual(['server frontend frontend:3000'])
})

test('catalog Postgres uses asynchronous commits without replacing its entrypoint or storage', () => {
  const { spec } = resource<Workload>('StatefulSet', 'postgres').spec.template
  const postgres = spec.containers.find(({ name }) => name === 'postgres')

  expect(postgres?.args).toEqual(['-c', 'synchronous_commit=off'])
  expect(postgres?.command).toBeUndefined()
  expect(postgres?.image).toMatch(/^pgvector\/pgvector:/)
  expect(postgres?.env).toContainEqual({
    name: 'POSTGRES_PASSWORD',
    valueFrom: { secretKeyRef: { name: 'auto-ontology-secrets', key: 'POSTGRES_PASSWORD' } },
  })
  expect(postgres?.env?.map(({ name }) => name)).not.toContain('PGDATA')
  expect(postgres?.volumeMounts).toEqual([{ name: 'data', mountPath: '/var/lib/postgresql' }])
  expect(spec.volumes).toContainEqual({ name: 'data', persistentVolumeClaim: { claimName: 'postgres-data' } })
})

test('SQL routing and non-reasoning thinking are patched on the backend image from a versioned ConfigMap', () => {
  const { spec } = resource<Workload & WithInitContainers>('Deployment', 'auto-ontology').spec.template
  const backend = spec.containers.find(({ name }) => name === 'backend')
  expect(spec.initContainers.slice(0, 2).map(({ name }) => name)).toEqual(['copy-sql-runtime', 'apply-sql-routing'])
  expect(spec.initContainers[0].image).toBe(backend?.image)
  expect(spec.initContainers[0].args?.join('\n')).toContain('cp -R /app/auto_ontology/utils/. /work/original-utils/')
  expect(spec.initContainers[0].args?.join('\n')).toContain(
    'cp -R /app/auto_ontology/retrieval/entity_coverage/. /work/original-entity-coverage/',
  )
  expect(spec.initContainers[1].args?.join('\n')).toContain('patch -p1 -i /config/non-reasoning-thinking.patch')
  expect(spec.initContainers[1].args?.join('\n')).toContain('patch -p1 -i /config/entity-coverage-non-reasoning.patch')
  expect(backend?.volumeMounts).toContainEqual({
    name: 'sql-runtime',
    mountPath: '/app/auto_ontology/retrieval/text_to_sql',
    subPath: 'patched',
    readOnly: true,
  })
  expect(backend?.volumeMounts).toContainEqual({
    name: 'sql-runtime',
    mountPath: '/app/auto_ontology/utils',
    subPath: 'patched-utils',
    readOnly: true,
  })
  expect(backend?.volumeMounts).toContainEqual({
    name: 'sql-runtime',
    mountPath: '/app/auto_ontology/retrieval/entity_coverage',
    subPath: 'patched-entity-coverage',
    readOnly: true,
  })
  const name = spec.volumes?.find((v) => v.name === 'sql-routing')?.configMap?.name
  expect(name).toMatch(/^auto-ontology-sql-routing-[a-z0-9]+$/)
  const configMap = resource<Resource & { data: Record<string, string> }>('ConfigMap', name!)
  expect(configMap.data['sql-routing.patch']).toContain('def resolve_connector_for_sql(')
  expect(configMap.data['non-reasoning-thinking.patch']).toContain('def _with_thinking_disabled(')
  expect(configMap.data['non-reasoning-thinking.patch']).toContain('AUTO_ONTOLOGY_NON_REASONING_DISABLE_THINKING')
  expect(configMap.data['entity-coverage-non-reasoning.patch']).toContain('get_non_reasoning_llm_client()')
})

test('ingestion loads the corrected client from its own pinned image', () => {
  const { spec } = resource<Workload & WithInitContainers>('Deployment', 'ingestion').spec.template
  const worker = spec.containers.find(({ name }) => name === 'ingestion')
  const init = spec.initContainers.find(({ name }) => name === 'configure-nvidia-timeout')
  expect(init?.image).toMatch(/@sha256:[0-9a-f]{64}$/)
  expect(init?.image).toBe(worker?.image)
  expect(worker?.env).toContainEqual({ name: 'LLM_INVOKE_TIMEOUT_S', value: '180' })
  expect(worker?.volumeMounts).toContainEqual({
    name: 'ingestion-client',
    mountPath: '/app/auto_ontology/utils/llm_invoke.py',
    subPath: 'llm_invoke.py',
    readOnly: true,
  })
})
