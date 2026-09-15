import type { TanstackServiceOptions } from '../templates/tanstack/types'

const argoRootKustomization = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - base
generators:
  - ../../applicationsets/product.yaml
generatorOptions:
  disableNameSuffixHash: true
`

const argoBaseKustomization = (
  opts: TanstackServiceOptions,
  includePostgres: boolean,
  includeRedis: boolean,
) => `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${opts.namespace ?? opts.name}

resources:
  - service.yaml
${opts.exposure === 'tailscale' ? '  - tailscale-service.yaml\n' : '  - domain-mapping.yaml\n  - cluster-domain-claim.yaml\n'}${
  includePostgres ? '  - postgres.yaml\n' : ''
}${includeRedis ? '  - redis.yaml\n' : ''}
`

const argoOverlay = (opts: TanstackServiceOptions) => `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../base

images:
  - name: ${opts.imageRegistry}/${opts.imageRepository ?? `lab/${opts.name}`}
    newTag: ${opts.imageTag ?? 'latest'}
`

const knativeService = (opts: TanstackServiceOptions) => {
  const envLines: string[] = ['            - name: PORT', '              value: "3000"']
  if (opts.enablePostgres) {
    envLines.push(
      '            - name: DATABASE_URL',
      '              valueFrom:',
      '                secretKeyRef:',
      `                  name: ${opts.name}-db-superuser`,
      '                  key: uri',
    )
  }
  if (opts.enableRedis) {
    envLines.push(
      '            - name: REDIS_URL',
      '              valueFrom:',
      '                secretKeyRef:',
      `                  name: ${opts.name}-redis`,
      '                  key: url',
    )
  }

  const visibilityAnnotation =
    opts.exposure === 'tailscale' ? '    networking.knative.dev/visibility: cluster-local\n' : ''

  return `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${opts.name}
  namespace: ${opts.namespace ?? opts.name}
  labels:
    app.kubernetes.io/name: ${opts.name}
    app.kubernetes.io/component: web
    app.kubernetes.io/part-of: lab
${opts.exposure === 'tailscale' ? '    networking.knative.dev/visibility: cluster-local\n' : ''}  annotations:
${visibilityAnnotation}    autoscaling.knative.dev/minScale: "1"
    serving.knative.dev/rollout-duration: "10s"
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1"
        autoscaling.knative.dev/target: "80"
    spec:
      serviceAccountName: ${opts.name}
      containers:
        - image: ${opts.imageRegistry}/${opts.imageRepository ?? `lab/${opts.name}`}:${opts.imageTag ?? 'latest'}
          ports:
            - name: http1
              containerPort: ${opts.port ?? 3000}
          env:
${envLines.join('\n')}
          readinessProbe:
            httpGet:
              path: /
              port: ${opts.port ?? 3000}
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 5
          livenessProbe:
            httpGet:
              path: /
              port: ${opts.port ?? 3000}
            initialDelaySeconds: 10
            periodSeconds: 20
            timeoutSeconds: 5
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
  traffic:
    - latestRevision: true
      percent: 100
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${opts.name}
  namespace: ${opts.namespace ?? opts.name}
`
}

const tailscaleService = (opts: TanstackServiceOptions) => `apiVersion: v1
kind: Service
metadata:
  name: ${opts.name}-tailscale
  namespace: ${opts.namespace ?? opts.name}
  annotations:
    tailscale.com/expose: "true"
    tailscale.com/hostname: ${opts.tailscaleHostname ?? opts.name}
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
  selector:
    serving.knative.dev/service: ${opts.name}
  ports:
    - name: http
      port: 80
      targetPort: 3000
      protocol: TCP
`

const domainMapping = (name: string, domain: string, namespace: string) => `apiVersion: serving.knative.dev/v1
kind: DomainMapping
metadata:
  name: ${domain}
  namespace: ${namespace}
spec:
  ref:
    apiVersion: serving.knative.dev/v1
    kind: Service
    name: ${name}
`

const clusterDomainClaim = (name: string, domain: string) => `apiVersion: networking.internal.knative.dev/v1alpha1
kind: ClusterDomainClaim
metadata:
  name: ${domain}
spec:
  namespace: ${name}
`

const postgres = (name: string, namespace?: string) => `apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ${name}-db
  namespace: ${namespace ?? name}
spec:
  instances: 1
  bootstrap:
    initdb:
      database: ${name}
      owner: ${name}
  superuserSecret:
    name: ${name}-db-superuser
  enableSuperuserAccess: true
  monitoring:
    enablePodMonitor: true
`

const redis = (name: string, namespace?: string) => `apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: Redis
metadata:
  name: ${name}-redis
  namespace: ${namespace ?? name}
spec:
  kubernetesConfig:
    image: quay.io/opstree/redis:v7.0.15
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: 50m
        memory: 128Mi
      limits:
        cpu: 200m
        memory: 256Mi
  podSecurityContext:
    fsGroup: 1000
    fsGroupChangePolicy: Always
  redisExporter:
    enabled: true
    image: quay.io/opstree/redis-exporter:v1.78.0
  storage:
    volumeClaimTemplate:
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 5Gi
        storageClassName: rook-ceph-block
`

export {
  argoBaseKustomization,
  argoOverlay,
  argoRootKustomization,
  clusterDomainClaim,
  domainMapping,
  knativeService,
  postgres,
  redis,
  tailscaleService,
}
