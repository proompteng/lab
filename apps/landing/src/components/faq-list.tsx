import type { FaqItem } from '@/app/config'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'

const FAQ_SECTION_ID = 'faq'
const FAQ_HEADING_ID = 'faq-heading'

type FaqListProps = {
  kicker: string
  heading: string
  description: string
  items: FaqItem[]
}

export default function FaqList({ kicker, heading, description, items }: FaqListProps) {
  return (
    <section
      id={FAQ_SECTION_ID}
      aria-labelledby={FAQ_HEADING_ID}
      className="rounded-3xl border bg-card/70 px-6 py-12 shadow-sm backdrop-blur sm:px-10"
    >
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">{kicker}</p>
        <h2 id={FAQ_HEADING_ID} className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          {heading}
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">{description}</p>
      </div>

      <Accordion type="single" collapsible className="mx-auto mt-8 max-w-3xl divide-y divide-border/60">
        {items.map(({ question, answer }, index) => (
          <AccordionItem key={question} value={`faq-${index}`}>
            <AccordionTrigger>{question}</AccordionTrigger>
            <AccordionContent>{answer}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  )
}
