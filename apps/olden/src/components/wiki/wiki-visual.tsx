type WikiVisualProps = {
  src: string
  alt: string
  caption: string
}

export function WikiVisual({ src, alt, caption }: WikiVisualProps) {
  return (
    <figure className="not-prose my-10 overflow-hidden rounded-lg border border-fd-border bg-fd-card shadow-xl">
      <img className="aspect-video w-full object-cover" src={src} alt={alt} loading="eager" />
      <figcaption className="border-t border-fd-border px-5 py-4 text-sm leading-6 text-fd-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  )
}
