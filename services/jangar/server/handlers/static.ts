import { HTTPError, defineEventHandler } from 'h3'
import { decodePath, joinURL, withLeadingSlash, withoutTrailingSlash } from 'ufo'
import { getAsset, isPublicAssetURL, readAsset } from '#nitro-internal-virtual/public-assets'

const METHODS = new Set(['HEAD', 'GET'])
const EncodingMap: Record<string, string> = {
  gzip: '.gz',
  br: '.br',
}

export default defineEventHandler(async (event) => {
  if (event.req.method && !METHODS.has(event.req.method)) {
    return
  }

  let id = decodePath(withLeadingSlash(withoutTrailingSlash(event.url.pathname)))
  let asset: ReturnType<typeof getAsset> | undefined

  const encodingHeader = event.req.headers.get('accept-encoding') || ''
  const encodings = [
    ...encodingHeader
      .split(',')
      .map((e) => EncodingMap[e.trim()])
      .filter(Boolean)
      .sort(),
    '',
  ]

  if (encodings.length > 1) {
    event.res.headers.append('Vary', 'Accept-Encoding')
  }

  for (const encoding of encodings) {
    for (const candidate of [id + encoding, joinURL(id, `index.html${encoding}`)]) {
      const candidateAsset = getAsset(candidate)
      if (candidateAsset) {
        asset = candidateAsset
        id = candidate
        break
      }
    }
  }

  if (!asset) {
    if (isPublicAssetURL(id)) {
      event.res.headers.delete('Cache-Control')
      throw new HTTPError({ status: 404 })
    }
    return
  }

  if (event.req.headers.get('if-none-match') === asset.etag) {
    event.res.status = 304
    event.res.statusText = 'Not Modified'
    return ''
  }

  const ifModifiedSince = event.req.headers.get('if-modified-since')
  const mtimeDate = new Date(asset.mtime)
  if (ifModifiedSince && asset.mtime && new Date(ifModifiedSince) >= mtimeDate) {
    event.res.status = 304
    event.res.statusText = 'Not Modified'
    return ''
  }

  if (asset.type) {
    event.res.headers.set('Content-Type', asset.type)
  }
  if (asset.etag && !event.res.headers.has('ETag')) {
    event.res.headers.set('ETag', asset.etag)
  }
  if (asset.mtime && !event.res.headers.has('Last-Modified')) {
    event.res.headers.set('Last-Modified', mtimeDate.toUTCString())
  }
  if (asset.encoding && !event.res.headers.has('Content-Encoding')) {
    event.res.headers.set('Content-Encoding', asset.encoding)
  }
  if (asset.size > 0 && !event.res.headers.has('Content-Length')) {
    event.res.headers.set('Content-Length', asset.size.toString())
  }

  return readAsset(id)
})
