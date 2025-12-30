import { Chart, type ChartProps, Duration } from 'cdk8s'
import {
  Deployment,
  EnvFieldPaths,
  EnvValue,
  HorizontalPodAutoscaler,
  Metric,
  MetricTarget,
  Probe,
  Service,
  type ServicePort,
  ServiceType,
} from 'cdk8s-plus-33'
import type { Construct } from 'constructs'

export interface ServerChartProps extends ChartProps {
  readonly image: string
  readonly replicas?: number
  readonly containerPort?: number
  readonly cpuTargetUtilizationPercent?: number
  readonly tempoTracesEndpoint?: string
  readonly mimirMetricsEndpoint?: string
  readonly lokiEndpoint?: string
}

export class ServerChart extends Chart {
  constructor(scope: Construct, id: string, props: ServerChartProps) {
    super(scope, id, props)

    const appLabel = 'bonjour'
    const namespace = props.namespace ?? 'default'
    const port = props.containerPort ?? 3000
    const minReplicas = Math.max(props.replicas ?? 1, 1)
    const targetCpu = Math.min(Math.max(props.cpuTargetUtilizationPercent ?? 70, 1), 100)

    const tempoTracesEndpoint =
      props.tempoTracesEndpoint ?? 'http://observability-tempo-gateway.observability.svc.cluster.local:4318/v1/traces'
    const mimirMetricsEndpoint =
      props.mimirMetricsEndpoint ?? 'http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics'
    const lokiEndpoint =
      props.lokiEndpoint ??
      'http://observability-loki-loki-distributed-gateway.observability.svc.cluster.local/loki/api/v1/push'

    const deployment = new Deployment(this, 'server', {
      metadata: {
        namespace,
        labels: {
          app: appLabel,
        },
      },
      podMetadata: {
        labels: {
          app: appLabel,
        },
      },
      securityContext: {
        ensureNonRoot: true,
        user: 1000,
        group: 1000,
        fsGroup: 1000,
      },
    })

    deployment.addContainer({
      name: 'server',
      image: props.image,
      portNumber: port,
      envVariables: {
        PORT: EnvValue.fromValue(String(port)),
        NODE_ENV: EnvValue.fromValue('production'),
        OTEL_SERVICE_NAME: EnvValue.fromValue(appLabel),
        LGTM_TEMPO_TRACES_ENDPOINT: EnvValue.fromValue(tempoTracesEndpoint),
        LGTM_MIMIR_METRICS_ENDPOINT: EnvValue.fromValue(mimirMetricsEndpoint),
        LGTM_LOKI_ENDPOINT: EnvValue.fromValue(lokiEndpoint),
        OTEL_EXPORTER_OTLP_PROTOCOL: EnvValue.fromValue('http/protobuf'),
        POD_NAME: EnvValue.fromFieldRef(EnvFieldPaths.POD_NAME),
        POD_NAMESPACE: EnvValue.fromFieldRef(EnvFieldPaths.POD_NAMESPACE),
      },
      securityContext: {
        ensureNonRoot: true,
        user: 1000,
        group: 1000,
      },
      readiness: Probe.fromHttpGet('/healthz', {
        port,
        initialDelaySeconds: Duration.seconds(5),
        periodSeconds: Duration.seconds(10),
      }),
      liveness: Probe.fromHttpGet('/healthz', {
        port,
        initialDelaySeconds: Duration.seconds(10),
        periodSeconds: Duration.seconds(10),
      }),
    })

    const ports: ServicePort[] = [
      {
        name: 'http',
        port,
        targetPort: port,
      },
    ]

    new Service(this, 'service', {
      metadata: {
        namespace,
        labels: {
          app: appLabel,
        },
      },
      selector: deployment,
      type: ServiceType.CLUSTER_IP,
      ports,
    })

    new HorizontalPodAutoscaler(this, 'hpa', {
      metadata: {
        namespace,
        labels: {
          app: appLabel,
        },
      },
      target: deployment,
      minReplicas,
      maxReplicas: Math.max(minReplicas * 2, minReplicas + 1),
      metrics: [Metric.resourceCpu(MetricTarget.averageUtilization(targetCpu))],
    })
  }
}
