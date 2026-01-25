import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
    },
    sitemap: 'https://proompteng.ai/sitemap.xml',
    host: 'https://proompteng.ai',
  }
}
