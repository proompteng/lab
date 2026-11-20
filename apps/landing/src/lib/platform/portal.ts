export const portalSections = [
  'overview',
  'people',
  'integrations',
  'resources',
  'connections',
  'requests',
  'activity',
  'settings',
] as const
export type PortalSection = (typeof portalSections)[number]

export const portalPages: Record<PortalSection, { title: string; description: string }> = {
  overview: { title: 'Overview', description: 'The people, applications and resources in your workspace.' },
  people: { title: 'People & access', description: 'Manage membership and administrative access.' },
  integrations: {
    title: 'Integrations',
    description: 'Manage registered applications. Enrollment and resource permissions are separate.',
  },
  resources: {
    title: 'Resource access',
    description: 'Approve named operations for members, people and registered clients.',
  },
  connections: {
    title: 'Connections',
    description: 'Manage shared provider consent. Connecting an account never grants permission.',
  },
  requests: { title: 'Access requests', description: 'Review requested capabilities and inspect previous decisions.' },
  activity: { title: 'Activity', description: 'Inspect workspace changes, execution outcomes and denied access.' },
  settings: { title: 'Settings', description: 'Workspace configuration and security boundaries.' },
}

export const portalPath = (workspaceId: string, section: PortalSection, query?: Record<string, string>) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/${section}${query ? '?' + new URLSearchParams(query) : ''}`
