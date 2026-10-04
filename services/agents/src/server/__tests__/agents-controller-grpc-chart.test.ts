import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const readChartTemplate = (name: string) =>
  readFileSync(new URL(`../../../../../charts/agents/templates/${name}`, import.meta.url), 'utf8')

describe('Agents controller gRPC chart wiring', () => {
  it('routes the controller Service to the configured listener port', () => {
    const service = readChartTemplate('service-controllers-grpc.yaml')
    const deployment = readChartTemplate('deployment-controllers.yaml')

    expect(service).toContain('$controllerGrpcPort := .Values.grpc.port | default 50051')
    expect(service).toContain('hasKey $controllersEnvVars "AGENTS_GRPC_PORT"')
    expect(service).toContain('$controllerGrpcPort = index $controllersEnvVars "AGENTS_GRPC_PORT"')
    expect(service).toContain('targetPort: {{ $controllerGrpcPort }}')
    expect(service).not.toContain('targetPort: grpc')
    expect(deployment).toContain('- name: AGENTS_GRPC_PORT')
    expect(deployment).toContain('value: {{ .Values.grpc.port | quote }}')
  })
})
