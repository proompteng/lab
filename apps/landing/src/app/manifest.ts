import type { MetadataRoute } from 'next'

import { isTengriAuthConfigured } from '@/lib/tengri/auth'
import { shouldRenderTengriDesktop } from '@/lib/tengri/desktop-gate'
import { isTengriControlPlaneConfigured } from '@/lib/tengri/grpc'
import { createProductManifest } from '@/lib/tengri/product-identity'

export const dynamic = 'force-dynamic'

export default function manifest(): MetadataRoute.Manifest {
  const tengriAvailable = shouldRenderTengriDesktop(isTengriAuthConfigured(), isTengriControlPlaneConfigured())
  return createProductManifest(tengriAvailable)
}
