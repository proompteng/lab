type WikiVisualProps = {
  src: string
  alt: string
  caption: string
}

export function WikiVisual({ src, alt, caption }: WikiVisualProps) {
  return (
    <figure className="not-prose my-8 overflow-hidden rounded-lg border border-fd-border bg-fd-card shadow-xl">
      <img className="aspect-video w-full object-cover" src={src} alt={alt} loading="eager" />
      <figcaption className="border-t border-fd-border px-4 py-3 text-xs text-fd-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  )
}
