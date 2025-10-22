import { createMetadataImage } from 'fumadocs-core/server'
import { loader, type Source } from 'fumadocs-core/source'
import { docs as generatedDocs } from '@/.source'

const baseUrl = '/docs'

type RuntimeDocs = typeof generatedDocs
type DocsSourceConfig = {
  pageData: RuntimeDocs['docs'][number]
  metaData: RuntimeDocs['meta'][number]
}

const mdxSource = generatedDocs.toFumadocsSource() as Source<DocsSourceConfig>

export const source = loader<DocsSourceConfig>({
  baseUrl,
  source: mdxSource,
  url: (slugs, locale) => {
    const suffix = slugs.length ? `/${slugs.join('/')}` : ''
    const localePrefix = locale ? `/${locale}` : ''

    return `${baseUrl}${localePrefix}${suffix}`
  },
})

type DocsPage = Awaited<ReturnType<typeof source.getPages>>[number]

const metadata = createMetadataImage({
  source,
  imageRoute: '/og/docs',
  filename: 'og.png',
})

export const getPageImage = (page: DocsPage) => ({
  ...metadata.getImageMeta(page.slugs),
  segments: page.slugs,
})

export const generateOgImageParams = metadata.generateParams

export async function getLLMText(page: DocsPage) {
  const rawContent = await page.data.getText('processed').catch(async () => page.data.getText('raw'))

  const header = [`# ${page.data.title}`, page.data.description?.trim(), page.url].filter(Boolean).join('\n\n')

  return [header, rawContent.trim()].filter(Boolean).join('\n\n')
}
