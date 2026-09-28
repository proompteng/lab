import type { ComparisonPoint } from '@/app/config'

const CONTROL_PLANE_SECTION_ID = 'control-plane'
const CONTROL_PLANE_HEADING_ID = 'control-plane-heading'

type ControlPlaneOverviewProps = {
  kicker: string
  heading: string
  description: string
  comparisonHeading: string
  comparisonNote: string
  points: ComparisonPoint[]
}

export default function ControlPlaneOverview({
  kicker,
  heading,
  description,
  comparisonHeading,
  comparisonNote,
  points,
}: ControlPlaneOverviewProps) {
  return (
    <section
      id={CONTROL_PLANE_SECTION_ID}
      aria-labelledby={CONTROL_PLANE_HEADING_ID}
      className="rounded-3xl border bg-card/75 px-6 py-12 shadow-sm backdrop-blur sm:px-12"
    >
      <div className="mx-auto max-w-4xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">{kicker}</p>
        <h2 id={CONTROL_PLANE_HEADING_ID} className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          {heading}
        </h2>
        <p className="mt-3 text-sm text-muted-foreground sm:text-base">{description}</p>
      </div>

      <dl className="mx-auto mt-10 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border bg-secondary/15 p-6 text-left">
          <dt className="text-sm font-semibold text-foreground">Policy checks</dt>
          <dd className="mt-2 text-sm text-muted-foreground">
            Keep prompts, tools, and data access in one reviewed policy layer.
          </dd>
        </div>
        <div className="rounded-2xl border bg-secondary/15 p-6 text-left">
          <dt className="text-sm font-semibold text-foreground">Run visibility</dt>
          <dd className="mt-2 text-sm text-muted-foreground">Trace and replay runs so teams can see what happened.</dd>
        </div>
        <div className="rounded-2xl border bg-secondary/15 p-6 text-left">
          <dt className="text-sm font-semibold text-foreground">Model routing</dt>
          <dd className="mt-2 text-sm text-muted-foreground">
            Choose models by task, cost, or latency instead of hardcoding.
          </dd>
        </div>
        <div className="rounded-2xl border bg-secondary/15 p-6 text-left">
          <dt className="text-sm font-semibold text-foreground">Operational control</dt>
          <dd className="mt-2 text-sm text-muted-foreground">
            Keep rollouts and incident response visible to the right people.
          </dd>
        </div>
      </dl>

      <div className="mt-12">
        <h3 className="text-center text-xl font-semibold tracking-tight sm:text-2xl">{comparisonHeading}</h3>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-0 text-left text-sm">
            <caption className="sr-only">
              Comparison between proompteng, Salesforce Agentforce, and Google Gemini
            </caption>
            <thead>
              <tr>
                <th scope="col" className="rounded-tl-xl border border-border/60 bg-secondary/25 px-4 py-3 font-medium">
                  Capability
                </th>
                <th scope="col" className="border border-border/60 bg-secondary/40 px-4 py-3 font-semibold">
                  proompteng
                </th>
                <th scope="col" className="border border-border/60 bg-secondary/25 px-4 py-3 font-medium">
                  Agentforce 360
                </th>
                <th scope="col" className="rounded-tr-xl border border-border/60 bg-secondary/25 px-4 py-3 font-medium">
                  Google Gemini for Agents
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map(({ capability, proompteng, salesforceAgentforce, googleGemini }, index) => {
                const isLast = index === points.length - 1
                return (
                  <tr key={capability}>
                    <th
                      scope="row"
                      className={`border border-border/60 bg-card/40 px-4 py-4 text-left font-semibold ${
                        isLast ? 'rounded-bl-xl' : ''
                      }`}
                    >
                      {capability}
                    </th>
                    <td className="border border-border/60 bg-card/80 px-4 py-4 font-medium text-foreground">
                      {proompteng}
                    </td>
                    <td className="border border-border/60 bg-card/60 px-4 py-4 text-muted-foreground">
                      {salesforceAgentforce}
                    </td>
                    <td
                      className={`border border-border/60 bg-card/60 px-4 py-4 text-muted-foreground ${
                        isLast ? 'rounded-br-xl' : ''
                      }`}
                    >
                      {googleGemini}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">{comparisonNote}</p>
      </div>
    </section>
  )
}
