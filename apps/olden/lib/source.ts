import { loader } from 'fumadocs-core/source'
import { docs as generatedDocs } from '@/.source/server'

const baseUrl = '/docs'

const mdxSource = generatedDocs.toFumadocsSource()

export const source = loader({
  baseUrl,
  source: mdxSource,
  url: (slugs, locale) => {
    const suffix = slugs.length ? `/${slugs.join('/')}` : ''
    const localePrefix = locale ? `/${locale}` : ''

    return `${baseUrl}${localePrefix}${suffix}`
  },
})

type DocsPage = NonNullable<ReturnType<typeof source.getPage>>

const ogImageRoute = '/og/docs'
const ogImageFilename = 'og.png'

const getOgImageSegments = (page: DocsPage) => [...page.slugs, ogImageFilename]

export const getPageImage = (page: DocsPage) => {
  const segments = getOgImageSegments(page)
  return {
    url: `${ogImageRoute}/${segments.join('/')}`,
    segments,
  }
}

export const generateOgImageParams = () => source.getPages().map((page) => ({ slug: getOgImageSegments(page) }))

export async function getLLMText(page: DocsPage) {
  const rawContent = await page.data.getText('processed').catch(async () => page.data.getText('raw'))

  const header = [`# ${page.data.title}`, page.data.description?.trim(), page.url].filter(Boolean).join('\n\n')

  return [header, rawContent.trim()].filter(Boolean).join('\n\n')
}
