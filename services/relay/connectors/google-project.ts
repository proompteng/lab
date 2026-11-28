import type { ConnectorRegistration } from '../onboarding'

const target = { name: 'proompteng-ai', kind: 'google.project', id: '952507162578' }

export default {
  connector: {
    type: 'http',
    id: 'google-project',
    endpoint: 'https://cloudresourcemanager.googleapis.com/',
    authentication: {
      type: 'workload_identity',
      federation: {
        spiffe_id: 'spiffe://proompteng.ai/ns/relay/sa/relay',
        audience:
          '//iam.googleapis.com/projects/952507162578/locations/global/workloadIdentityPools/proompteng-ai/providers/spire',
        token_endpoint: 'https://sts.googleapis.com/v1/token',
        scopes: ['https://www.googleapis.com/auth/cloud-platform.read-only'],
      },
    },
    operations: [
      {
        operation: {
          name: 'read',
          description: "Read the federation test project's metadata",
          action: 'google.project.read',
          read_only: true,
          target,
          input_schema: { type: 'object', properties: {}, additionalProperties: false },
        },
        method: 'GET',
        path: '/v3/projects/952507162578',
      },
    ],
  },
  policy: {
    kind: target.kind,
    nativeType: 'google_project',
    actions: [
      {
        id: 'google.project.read',
        permission: 'read',
        grantRelation: 'reader',
        workspaceGrantRelation: 'reader_workspace',
      },
    ],
  },
  targets: [{ workspaceId: 'e984074d-8b6d-5244-9fdb-59ff5d4a5836', id: target.id, name: target.name }],
} satisfies ConnectorRegistration
