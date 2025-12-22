import { createFileRoute } from '@tanstack/react-router'

type RegistryImage = {
  name: string
  tags: string[]
  error?: string
}

const registryBaseUrl = 'https://registry.ide-newton.ts.net'

async function fetchRegistryImages(): Promise<{
  images: RegistryImage[]
  error?: string
  fetchedAt: string
}> {
  const fetchedAt = new Date().toISOString()

  try {
    const catalogResponse = await fetch(new URL('/v2/_catalog', registryBaseUrl))
    if (!catalogResponse.ok) {
      return {
        images: [],
        error: `Registry catalog request failed (${catalogResponse.status})`,
        fetchedAt,
      }
    }

    const catalog = (await catalogResponse.json()) as { repositories?: string[] }
    const repositories = catalog.repositories ?? []

    const images = await Promise.all(
      repositories.map(async (repository) => {
        try {
          const tagsResponse = await fetch(new URL(`/v2/${repository}/tags/list`, registryBaseUrl))
          if (!tagsResponse.ok) {
            return {
              name: repository,
              tags: [],
              error: `Tags request failed (${tagsResponse.status})`,
            }
          }

          const tagsPayload = (await tagsResponse.json()) as { tags?: string[] }

          return {
            name: repository,
            tags: tagsPayload.tags ?? [],
          }
        } catch (error) {
          return {
            name: repository,
            tags: [],
            error: error instanceof Error ? error.message : 'Failed to load tags',
          }
        }
      }),
    )

    return { images, fetchedAt }
  } catch (error) {
    return {
      images: [],
      error: error instanceof Error ? error.message : 'Failed to load registry',
      fetchedAt,
    }
  }
}

export const Route = createFileRoute('/')({
  component: App,
  loader: fetchRegistryImages,
})

function App() {
  const { images, error, fetchedAt } = Route.useLoaderData()
  const formattedTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(fetchedAt))

  return (
    <section className="bg-card text-card-foreground mx-auto mt-12 w-full max-w-5xl rounded-xl border p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Registry images</h2>
          <p className="text-muted-foreground text-sm">Data source: {registryBaseUrl}</p>
        </div>
        <p className="text-muted-foreground text-xs">Fetched {formattedTime}</p>
      </div>
      {error ? (
        <p role="alert" className="text-destructive mt-4 text-sm">
          {error}
        </p>
      ) : null}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="text-muted-foreground mb-3 text-left text-xs">
            Registry repositories and their available tags.
          </caption>
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-2 py-2 font-semibold">
                Repository
              </th>
              <th scope="col" className="px-2 py-2 font-semibold">
                Tags
              </th>
              <th scope="col" className="px-2 py-2 font-semibold">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {images.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-2 py-6 text-center text-sm">
                  No images found in the registry.
                </td>
              </tr>
            ) : (
              images.map((image) => (
                <tr key={image.name}>
                  <td className="px-2 py-3 font-medium">{image.name}</td>
                  <td className="px-2 py-3">
                    {image.tags.length ? (
                      <div className="flex flex-wrap gap-2">
                        {image.tags.map((tag) => (
                          <span key={tag} className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">No tags</span>
                    )}
                  </td>
                  <td className="px-2 py-3 text-xs">
                    {image.error ? (
                      <span className="text-destructive">{image.error}</span>
                    ) : (
                      <span className="text-emerald-600">OK</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
