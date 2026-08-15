import { parse } from 'yaml'

const sourceShaPattern = /^[0-9a-f]{40}$/
const tagPattern = /^[A-Za-z0-9._-]{1,128}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/
const imageRepository = 'registry.ide-newton.ts.net/lab/bayn'
export const baynLifecycleOperationTimeoutMs = 30_000
export const baynLifecycleRegistrationActiveDeadlineSeconds = 720
export const baynLifecycleOtlpTracesEndpoint =
  'http://observability-tempo-distributor.observability.svc.cluster.local:4318/v1/traces'

export const baynLifecycleCurrentPath = 'argocd/applications/bayn/lifecycle-current.yaml'
export const baynLifecyclePreviousPath = 'argocd/applications/bayn/lifecycle-previous.yaml'

export interface BaynLifecycleImagePin {
  readonly sourceSha: string
  readonly tag: string
  readonly digest: string
}

export interface BaynLifecycleManifestPair {
  readonly current: string
  readonly previous: string
}

const validatePin = (pin: BaynLifecycleImagePin): void => {
  if (!sourceShaPattern.test(pin.sourceSha)) throw new Error(`invalid lifecycle source SHA: ${pin.sourceSha}`)
  if (!tagPattern.test(pin.tag)) throw new Error(`invalid lifecycle image tag: ${pin.tag}`)
  if (!digestPattern.test(pin.digest)) throw new Error(`invalid lifecycle image digest: ${pin.digest}`)
  if (pin.tag !== `sha-${pin.sourceSha}`) {
    throw new Error(`lifecycle image tag ${pin.tag} does not bind source ${pin.sourceSha}`)
  }
}

const version = (sourceSha: string): string => sourceSha.slice(0, 12)
const workloadName = (sourceSha: string): string => `bayn-lifecycle-${version(sourceSha)}`
const image = (pin: BaynLifecycleImagePin): string => `${imageRepository}:${pin.tag}@${pin.digest}`

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const baynPodSpec = (deployment: string): Record<string, unknown> => {
  const manifest: unknown = parse(deployment)
  const spec = record(manifest) && record(manifest.spec) ? manifest.spec : undefined
  const template = spec !== undefined && record(spec.template) ? spec.template : undefined
  const podSpec = template !== undefined && record(template.spec) ? template.spec : undefined
  if (podSpec === undefined) throw new Error('Bayn deployment must contain a pod spec')
  return podSpec
}

const baynContainer = (deployment: string): Record<string, unknown> => {
  const podSpec = baynPodSpec(deployment)
  const containers = podSpec !== undefined && Array.isArray(podSpec.containers) ? podSpec.containers : []
  const baynContainers = containers.filter((container) => record(container) && container.name === 'bayn')
  if (baynContainers.length !== 1 || !record(baynContainers[0])) {
    throw new Error('Bayn deployment must contain exactly one bayn container')
  }
  return baynContainers[0]
}

export const validateBaynLifecycleCommandPort = (deployment: string): void => {
  const container = baynContainer(deployment)
  const ports = container.ports
  const lifecyclePorts = Array.isArray(ports)
    ? ports.filter(
        (port) =>
          record(port) && port.name === 'lifecycle-cmd' && port.containerPort === 8081 && port.protocol === 'TCP',
      )
    : []
  if (lifecyclePorts.length !== 1) {
    throw new Error('Bayn deployment must expose exactly one lifecycle-cmd container port on TCP 8081')
  }
}

export const validateBaynServiceLinksDisabled = (deployment: string): void => {
  if (baynPodSpec(deployment).enableServiceLinks !== false) {
    throw new Error('Bayn deployment must disable Kubernetes service-link environment injection')
  }
}

export const validateBaynLifecycleCommandAuthentication = (deployment: string): void => {
  const container = baynContainer(deployment)
  const mounts = Array.isArray(container.volumeMounts) ? container.volumeMounts : []
  const reviewerMounts = mounts.filter(
    (mount) =>
      record(mount) &&
      mount.name === 'bayn-lifecycle-reviewer' &&
      mount.mountPath === '/var/run/secrets/bayn-lifecycle-reviewer' &&
      mount.readOnly === true,
  )
  if (reviewerMounts.length !== 1) {
    throw new Error('Bayn deployment must mount exactly one read-only lifecycle TokenReview identity')
  }
  const volumes = baynPodSpec(deployment).volumes
  const reviewerVolumes = Array.isArray(volumes)
    ? volumes.filter((volume) => record(volume) && volume.name === 'bayn-lifecycle-reviewer')
    : []
  if (reviewerVolumes.length !== 1 || !record(reviewerVolumes[0]?.projected)) {
    throw new Error('Bayn deployment must project exactly one lifecycle TokenReview identity')
  }
  const projected = reviewerVolumes[0].projected
  const sources = Array.isArray(projected.sources) ? projected.sources : []
  const serviceAccountTokens = sources.filter(
    (source) =>
      record(source) &&
      record(source.serviceAccountToken) &&
      source.serviceAccountToken.audience === undefined &&
      source.serviceAccountToken.expirationSeconds === 3600 &&
      source.serviceAccountToken.path === 'token',
  )
  const rootCas = sources.filter(
    (source) =>
      record(source) &&
      record(source.configMap) &&
      source.configMap.name === 'kube-root-ca.crt' &&
      Array.isArray(source.configMap.items) &&
      source.configMap.items.length === 1 &&
      record(source.configMap.items[0]) &&
      source.configMap.items[0].key === 'ca.crt' &&
      source.configMap.items[0].path === 'ca.crt',
  )
  if (projected.defaultMode !== 444 || serviceAccountTokens.length !== 1 || rootCas.length !== 1) {
    throw new Error(
      'Bayn lifecycle TokenReview identity must use the API server audience and be bounded and CA-verified',
    )
  }
}

export const validateBaynLifecycleOperationTimeout = (deployment: string): void => {
  const environment = baynContainer(deployment).env
  const timeouts = Array.isArray(environment)
    ? environment.filter((entry) => record(entry) && entry.name === 'BAYN_OPERATION_TIMEOUT_MS')
    : []
  if (
    timeouts.length !== 1 ||
    !record(timeouts[0]) ||
    timeouts[0].value !== baynLifecycleOperationTimeoutMs.toString()
  ) {
    throw new Error(
      `Bayn and Restate lifecycle must share BAYN_OPERATION_TIMEOUT_MS=${baynLifecycleOperationTimeoutMs.toString()}`,
    )
  }
}

const lifecycleOwner = (deployment: string): string | undefined => {
  const environment = baynContainer(deployment).env
  const owners = Array.isArray(environment)
    ? environment.filter((entry) => record(entry) && entry.name === 'BAYN_LIFECYCLE_OWNER')
    : []
  if (owners.length === 0) return undefined
  if (owners.length !== 1 || !record(owners[0]) || typeof owners[0].value !== 'string') {
    throw new Error('Bayn deployment must contain at most one literal BAYN_LIFECYCLE_OWNER value')
  }
  return owners[0].value
}

const workerManifest = (pin: BaynLifecycleImagePin): string => {
  const name = workloadName(pin.sourceSha)
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/name: bayn-lifecycle
    app.kubernetes.io/part-of: bayn
    app.kubernetes.io/version: ${version(pin.sourceSha)}
  annotations:
    bayn.proompteng.ai/source-revision: ${pin.sourceSha}
spec:
  replicas: 1
  revisionHistoryLimit: 1
  progressDeadlineSeconds: 600
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: bayn-lifecycle
      app.kubernetes.io/version: ${version(pin.sourceSha)}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: bayn-lifecycle
        app.kubernetes.io/part-of: bayn
        app.kubernetes.io/version: ${version(pin.sourceSha)}
    spec:
      serviceAccountName: bayn-lifecycle
      automountServiceAccountToken: false
      enableServiceLinks: false
      terminationGracePeriodSeconds: 30
      nodeSelector:
        kubernetes.io/arch: arm64
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: lifecycle
          image: ${image(pin)}
          imagePullPolicy: IfNotPresent
          command:
            - node
            - dist/restate-lifecycle-server.js
          ports:
            - name: restate
              containerPort: 9080
              protocol: TCP
          env:
            - name: BAYN_CODE_REVISION
              value: ${pin.sourceSha}
            - name: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
              value: ${baynLifecycleOtlpTracesEndpoint}
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  apiVersion: v1
                  fieldPath: metadata.namespace
            - name: BAYN_LIFECYCLE_CONTROLLER_KEY
              value: primary
            - name: BAYN_LIFECYCLE_COMMAND_URL
              value: http://bayn-lifecycle-command.bayn.svc.cluster.local:8081
            - name: BAYN_LIFECYCLE_COMMAND_TOKEN_PATH
              value: /var/run/secrets/bayn-lifecycle-command/token
            - name: BAYN_OPERATION_TIMEOUT_MS
              value: "${baynLifecycleOperationTimeoutMs.toString()}"
            - name: BAYN_CYCLE_POLL_INTERVAL_MS
              value: "30000"
            - name: PORT
              value: "9080"
            - name: NODE_ENV
              value: production
          startupProbe:
            tcpSocket:
              port: restate
            periodSeconds: 2
            failureThreshold: 30
          readinessProbe:
            tcpSocket:
              port: restate
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 2
          livenessProbe:
            tcpSocket:
              port: restate
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          resources:
            requests:
              cpu: 50m
              memory: 96Mi
            limits:
              cpu: 500m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: command-identity
              mountPath: /var/run/secrets/bayn-lifecycle-command
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: command-identity
          projected:
            defaultMode: 0444
            sources:
              - serviceAccountToken:
                  audience: bayn.proompteng.ai/lifecycle-command
                  expirationSeconds: 3600
                  path: token
        - name: tmp
          emptyDir:
            sizeLimit: 64Mi
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/name: bayn-lifecycle
    app.kubernetes.io/part-of: bayn
    app.kubernetes.io/version: ${version(pin.sourceSha)}
  annotations:
    bayn.proompteng.ai/source-revision: ${pin.sourceSha}
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: bayn-lifecycle
    app.kubernetes.io/version: ${version(pin.sourceSha)}
  ports:
    - name: restate
      port: 9080
      targetPort: restate
      protocol: TCP
`
}

export const renderBaynLifecycleCurrent = (pin: BaynLifecycleImagePin): string => {
  validatePin(pin)
  const name = workloadName(pin.sourceSha)
  return `${workerManifest(pin)}---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: bayn-lifecycle
  labels:
    app.kubernetes.io/name: bayn-lifecycle
    app.kubernetes.io/part-of: bayn
automountServiceAccountToken: false
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: bayn-lifecycle-token-reviewer
  labels:
    app.kubernetes.io/name: bayn-lifecycle-command
    app.kubernetes.io/part-of: bayn
rules:
  - apiGroups:
      - authentication.k8s.io
    resources:
      - tokenreviews
    verbs:
      - create
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: bayn-lifecycle-token-reviewer
  labels:
    app.kubernetes.io/name: bayn-lifecycle-command
    app.kubernetes.io/part-of: bayn
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: bayn-lifecycle-token-reviewer
subjects:
  - kind: ServiceAccount
    name: bayn
    namespace: bayn
---
apiVersion: v1
kind: Service
metadata:
  name: bayn-lifecycle-command
  labels:
    app.kubernetes.io/name: bayn-lifecycle-command
    app.kubernetes.io/part-of: bayn
spec:
  type: ClusterIP
  publishNotReadyAddresses: true
  selector:
    app.kubernetes.io/name: bayn
  ports:
    - name: lifecycle-cmd
      port: 8081
      targetPort: lifecycle-cmd
      protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: bayn-lifecycle-command
  labels:
    app.kubernetes.io/name: bayn-lifecycle-command
    app.kubernetes.io/part-of: bayn
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: bayn
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: bayn-lifecycle
      ports:
        - port: lifecycle-cmd
          protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: bayn-lifecycle-token-review
  labels:
    app.kubernetes.io/name: bayn-lifecycle-command
    app.kubernetes.io/part-of: bayn
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: bayn
  policyTypes:
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 10.96.0.1/32
      ports:
        - port: 443
          protocol: TCP
    # This cluster evaluates Service traffic after translation to the control-plane endpoint. Keep the API VIP above
    # and permit only the current control-plane endpoints on the secure API port.
    - to:
        - ipBlock:
            cidr: 100.100.244.141/32
        - ipBlock:
            cidr: 100.100.244.142/32
        - ipBlock:
            cidr: 100.100.244.190/32
      ports:
        - port: 6443
          protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: bayn-lifecycle-worker
  labels:
    app.kubernetes.io/name: bayn-lifecycle
    app.kubernetes.io/part-of: bayn
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: bayn-lifecycle
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: restate
          podSelector:
            matchLabels:
              app: restate
      ports:
        - port: restate
          protocol: TCP
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: bayn
      ports:
        - port: lifecycle-cmd
          protocol: TCP
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: observability
          podSelector:
            matchLabels:
              app.kubernetes.io/name: tempo
              app.kubernetes.io/component: distributor
      ports:
        - port: 4318
          protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: bayn-lifecycle-register
  labels:
    app.kubernetes.io/name: bayn-lifecycle-register
    app.kubernetes.io/part-of: bayn
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: bayn-lifecycle-register
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: restate
          podSelector:
            matchLabels:
              app: restate
      ports:
        - port: 9070
          protocol: TCP
        - port: 8080
          protocol: TCP
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: observability
          podSelector:
            matchLabels:
              app.kubernetes.io/name: tempo
              app.kubernetes.io/component: distributor
      ports:
        - port: 4318
          protocol: TCP
---
apiVersion: batch/v1
kind: Job
metadata:
  name: bayn-lifecycle-register-${version(pin.sourceSha)}
  labels:
    app.kubernetes.io/name: bayn-lifecycle-register
    app.kubernetes.io/part-of: bayn
    app.kubernetes.io/version: ${version(pin.sourceSha)}
  annotations:
    # The command Service publishes not-ready Bayn endpoints, so this same-wave hook can activate the first durable
    # tick that makes strict Restate-owned readiness healthy. PostSync would deadlock behind that readiness gate.
    argocd.argoproj.io/hook: Sync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation,HookSucceeded
spec:
  backoffLimit: 6
  activeDeadlineSeconds: ${baynLifecycleRegistrationActiveDeadlineSeconds.toString()}
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        app.kubernetes.io/name: bayn-lifecycle-register
        app.kubernetes.io/part-of: bayn
        app.kubernetes.io/version: ${version(pin.sourceSha)}
    spec:
      serviceAccountName: bayn
      automountServiceAccountToken: false
      enableServiceLinks: false
      restartPolicy: OnFailure
      nodeSelector:
        kubernetes.io/arch: arm64
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: register
          image: ${image(pin)}
          imagePullPolicy: IfNotPresent
          command:
            - node
            - dist/restate-lifecycle-register.js
          env:
            - name: BAYN_CODE_REVISION
              value: ${pin.sourceSha}
            - name: BAYN_LIFECYCLE_CONTROLLER_KEY
              value: primary
            - name: BAYN_OPERATION_TIMEOUT_MS
              value: "${baynLifecycleOperationTimeoutMs.toString()}"
            - name: BAYN_RESTATE_ENDPOINT_URI
              value: http://${name}.bayn.svc.cluster.local:9080
            - name: RESTATE_ADMIN_ORIGIN
              value: http://restate.restate.svc.cluster.local:9070
            - name: RESTATE_INGRESS_ORIGIN
              value: http://restate.restate.svc.cluster.local:8080
            - name: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
              value: ${baynLifecycleOtlpTracesEndpoint}
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  apiVersion: v1
                  fieldPath: metadata.namespace
            - name: NODE_ENV
              value: production
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 128Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
`
}

export const renderBaynLifecyclePrevious = (pin: BaynLifecycleImagePin | null): string => {
  if (pin === null) return 'apiVersion: v1\nkind: List\nitems: []\n'
  validatePin(pin)
  return workerManifest(pin)
}

const firstMatch = (source: string, pattern: RegExp, name: string): string => {
  const match = pattern.exec(source)?.[1]
  if (match === undefined) throw new Error(`expected ${name}`)
  return match
}

export const parseBaynLifecycleCurrent = (source: string): BaynLifecycleImagePin => {
  const sourceSha = firstMatch(
    source,
    /^    bayn\.proompteng\.ai\/source-revision: ([0-9a-f]{40})$/m,
    'current lifecycle source revision',
  )
  const reference = firstMatch(
    source,
    /^          image: (registry\.ide-newton\.ts\.net\/lab\/bayn:[^@\n]+@sha256:[0-9a-f]{64})$/m,
    'current lifecycle image',
  )
  const imageMatch = /^registry\.ide-newton\.ts\.net\/lab\/bayn:([^@]+)@(sha256:[0-9a-f]{64})$/.exec(reference)
  if (imageMatch?.[1] === undefined || imageMatch[2] === undefined) throw new Error('invalid current lifecycle image')
  const pin = { sourceSha, tag: imageMatch[1], digest: imageMatch[2] }
  validatePin(pin)
  if (source !== renderBaynLifecycleCurrent(pin)) throw new Error('current lifecycle manifest is not canonical')
  return pin
}

export const parseBaynLifecyclePrevious = (source: string): BaynLifecycleImagePin | null => {
  if (source === renderBaynLifecyclePrevious(null)) return null
  const sourceSha = firstMatch(
    source,
    /^    bayn\.proompteng\.ai\/source-revision: ([0-9a-f]{40})$/m,
    'previous lifecycle source revision',
  )
  const reference = firstMatch(
    source,
    /^          image: (registry\.ide-newton\.ts\.net\/lab\/bayn:[^@\n]+@sha256:[0-9a-f]{64})$/m,
    'previous lifecycle image',
  )
  const imageMatch = /^registry\.ide-newton\.ts\.net\/lab\/bayn:([^@]+)@(sha256:[0-9a-f]{64})$/.exec(reference)
  if (imageMatch?.[1] === undefined || imageMatch[2] === undefined) throw new Error('invalid previous lifecycle image')
  const pin = { sourceSha, tag: imageMatch[1], digest: imageMatch[2] }
  validatePin(pin)
  if (source !== renderBaynLifecyclePrevious(pin)) throw new Error('previous lifecycle manifest is not canonical')
  return pin
}

export const baynLifecycleIsActive = (kustomization: string): boolean => {
  const current = /^  - lifecycle-current\.yaml$/m.test(kustomization)
  const previous = /^  - lifecycle-previous\.yaml$/m.test(kustomization)
  if (current !== previous) throw new Error('Bayn lifecycle current and previous resources must be activated together')
  return current
}

export const validateBaynLifecycleActivation = (deployment: string, kustomization: string): void => {
  const active = baynLifecycleIsActive(kustomization)
  const owner = lifecycleOwner(deployment)
  if (active && owner !== 'RESTATE') {
    throw new Error('active Bayn lifecycle resources require BAYN_LIFECYCLE_OWNER=RESTATE')
  }
  if (!active && owner === 'RESTATE') {
    throw new Error('BAYN_LIFECYCLE_OWNER=RESTATE requires active Bayn lifecycle resources')
  }
  if (owner !== undefined && owner !== 'PROCESS' && owner !== 'RESTATE') {
    throw new Error(`invalid BAYN_LIFECYCLE_OWNER value: ${owner}`)
  }
}

export const advanceBaynLifecycleManifests = (input: {
  readonly base: BaynLifecycleManifestPair
  readonly kustomization: string
  readonly next: BaynLifecycleImagePin
}): BaynLifecycleManifestPair => {
  const current = parseBaynLifecycleCurrent(input.base.current)
  parseBaynLifecyclePrevious(input.base.previous)
  return {
    current: renderBaynLifecycleCurrent(input.next),
    previous: baynLifecycleIsActive(input.kustomization) ? renderBaynLifecyclePrevious(current) : input.base.previous,
  }
}

export const validateBaynLifecyclePromotion = (input: {
  readonly base: BaynLifecycleManifestPair
  readonly head: BaynLifecycleManifestPair
  readonly baseKustomization: string
  readonly next: BaynLifecycleImagePin
}): string | null => {
  try {
    const expected = advanceBaynLifecycleManifests({
      base: input.base,
      kustomization: input.baseKustomization,
      next: input.next,
    })
    if (input.head.current !== expected.current)
      return `${baynLifecycleCurrentPath} is not the exact next source endpoint`
    if (input.head.previous !== expected.previous) {
      return `${baynLifecyclePreviousPath} does not retain exactly the prior source endpoint`
    }
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Bayn lifecycle manifest validation failed'
  }
}
