export const portalSections = ['integrations', 'people', 'activity'] as const
export type PortalSection = (typeof portalSections)[number]
