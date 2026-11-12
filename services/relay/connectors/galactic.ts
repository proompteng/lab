import type { ConnectorRegistration } from '../onboarding'

const connector = {
  type: 'kubernetes',
  id: 'galactic',
  endpoint: 'https://kubernetes.default.svc/',
  ca_file: '/var/run/relay/kubernetes/ca.crt',
  token_file: '/var/run/relay/kubernetes/token',
  namespaces: [
    {
      name: 'ofz',
      uid: 'f4b6e45e-cd1b-426d-acd3-41b50219182e',
    },
    {
      name: 'tengri',
      uid: '32d21018-eca9-4c2c-8502-aa5dd41320eb',
    },
    {
      name: 'opencode',
      uid: 'f16c9bf3-6947-4438-8158-cef04834b558',
    },
  ],
} as const

export default {
  connector,
  policy: {
    kind: 'kubernetes.namespace',
    nativeType: 'kubernetes_namespace',
    actions: [
      {
        id: 'kubernetes.status.read',
        permission: 'read_status',
        grantRelation: 'status_reader',
        workspaceGrantRelation: 'status_workspace',
      },
      {
        id: 'kubernetes.logs.read',
        permission: 'read_logs',
        grantRelation: 'log_reader',
        workspaceGrantRelation: 'log_workspace',
      },
      {
        id: 'kubernetes.events.read',
        permission: 'read_events',
        grantRelation: 'event_reader',
        workspaceGrantRelation: 'event_workspace',
      },
    ],
  },
  targets: connector.namespaces.map((namespace) => ({
    workspaceId: 'e984074d-8b6d-5244-9fdb-59ff5d4a5836',
    id: `${connector.id}/${namespace.uid}`,
    name: namespace.name,
  })),
} satisfies ConnectorRegistration
