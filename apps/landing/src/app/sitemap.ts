import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = 'https://proompteng.ai'
  const now = new Date()

  return [
    {
      url: `${baseUrl}/`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: 'https://docs.proompteng.ai',
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
  ]
}
