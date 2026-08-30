import type { MetadataRoute } from 'next'

type ProductIdentity = Readonly<{
  backgroundColor: string
  description: string
  name: string
  openGraphImage: string
  shortName: string
  themeColor: string
}>

export const PUBLIC_PRODUCT_IDENTITY: ProductIdentity = {
  backgroundColor: '#0e0e10',
  description: 'A practical control plane for teams building and operating AI agents.',
  name: 'ProomptEng AI',
  openGraphImage: '/opengraph-image',
  shortName: 'ProomptEng',
  themeColor: '#0e0e10',
}

export const TENGRI_PRODUCT_IDENTITY: ProductIdentity = {
  backgroundColor: '#050914',
  description: 'A private Firecracker development desktop with persistent files, terminals, Codex, and previews.',
  name: 'Tengri MicroVM Desktop',
  openGraphImage: '/tengri/opengraph-image',
  shortName: 'Tengri',
  themeColor: '#050914',
}

export function selectProductIdentity(tengriAvailable: boolean): ProductIdentity {
  return tengriAvailable ? TENGRI_PRODUCT_IDENTITY : PUBLIC_PRODUCT_IDENTITY
}

export function createProductManifest(tengriAvailable: boolean): MetadataRoute.Manifest {
  const identity = selectProductIdentity(tengriAvailable)
  return {
    name: identity.name,
    short_name: identity.shortName,
    description: identity.description,
    start_url: '/',
    display: 'standalone',
    background_color: identity.backgroundColor,
    theme_color: identity.themeColor,
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/favicon.ico', sizes: 'any', type: 'image/x-icon' },
    ],
  }
}
