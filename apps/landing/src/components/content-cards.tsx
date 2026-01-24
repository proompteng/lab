import type { CardItem } from '@/app/config'
import InfoCard from '@/components/info-card'

type ContentCardsProps = {
  sectionId: string
  title: string
  items: CardItem[]
}

export default function ContentCards({ sectionId, title, items }: ContentCardsProps) {
  const headingId = `${sectionId}-heading`
  return (
    <section id={sectionId} aria-labelledby={headingId} className="mt-12 sm:mt-16">
      <h2 id={headingId} className="text-2xl sm:text-3xl font-semibold tracking-tight text-center">
        {title}
      </h2>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        {items.map(({ icon, title, text }) => (
          <InfoCard key={title} icon={icon} title={title} text={text} />
        ))}
      </div>
    </section>
  )
}
