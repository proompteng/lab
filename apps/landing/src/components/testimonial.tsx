import type { LandingContent } from '@/app/config'

const TESTIMONIAL_HEADING_ID = 'testimonial-heading'

type TestimonialProps = {
  kicker: LandingContent['testimonial']['kicker']
  quote: LandingContent['testimonial']['quote']
  author: LandingContent['testimonial']['author']
  org: LandingContent['testimonial']['org']
}

export default function Testimonial({ kicker, quote, author, org }: TestimonialProps) {
  return (
    <section
      aria-labelledby={TESTIMONIAL_HEADING_ID}
      className="rounded-3xl border bg-primary/10 px-6 py-12 shadow-sm backdrop-blur sm:px-12"
    >
      <div className="mx-auto max-w-3xl text-center text-primary">
        <p className="text-xs font-semibold uppercase tracking-[0.3em]">{kicker}</p>
        <h2 id={TESTIMONIAL_HEADING_ID} className="mt-2 text-3xl font-semibold tracking-tight text-primary sm:text-4xl">
          <span aria-hidden className="mr-2 inline-block text-5xl leading-none">
            &quot;
          </span>
          {quote}
          <span aria-hidden className="ml-2 inline-block text-5xl leading-none">
            &quot;
          </span>
        </h2>
        <p className="mt-6 text-sm uppercase tracking-[0.3em] text-primary/80">
          {author} - {org}
        </p>
      </div>
    </section>
  )
}
