import Link from 'next/link'

const highlights = [
  {
    title: 'Production-ready prompt pipelines',
    description:
      'Ship prompts with validation, observability, and rollbacks baked in so your team can iterate with confidence.',
  },
  {
    title: 'Environment aware by design',
    description:
      'Mirror staging and production behaviour with typed inputs, secrets, and rollout policies that travel with every deploy.',
  },
  {
    title: 'Model agnostic workflows',
    description:
      'Swap between OpenAI, Anthropic, or self-hosted models while keeping safety checks, evaluations, and tooling consistent.',
  },
  {
    title: 'Collaboration that scales',
    description:
      'Review changes, capture experiment notes, and onboard new teammates with a shared hub for everything prompt engineering.',
  },
]

const quickStartSteps = [
  {
    title: 'Install the CLI',
    description:
      'Get the proompteng command line installed to create environments, publish prompts, and inspect activity from your terminal.',
    code: 'npm install -g @proompteng/cli',
  },
  {
    title: 'Initialize a workspace',
    description:
      'Authenticate and scaffold a project with sensible defaults for evaluations, version control, and deployment pipelines.',
    code: 'proompteng init',
  },
  {
    title: 'Deploy your first prompt',
    description:
      'Link your providers, run smoke tests, and promote a prompt to production with a single command once checks succeed.',
    code: 'proompteng deploy',
  },
]

const resourceLinks = [
  {
    title: 'Getting started',
    description: 'Walk through environment setup, authentication, and the mental model behind proompteng projects.',
    href: '/docs/getting-started',
  },
  {
    title: 'API reference',
    description: 'Explore endpoint definitions, payload contracts, and code samples for integrating with your stack.',
    href: '/docs/api',
  },
  {
    title: 'Playbooks',
    description: 'Adopt production-ready checklists for incident response, evaluations, and gradual rollouts.',
    href: '/docs/playbooks',
  },
]

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-6 py-16 sm:px-8 lg:px-12">
        <section className="flex flex-col items-center gap-6 text-center">
          <p className="text-sm uppercase tracking-wide text-fd-muted-foreground">Documentation Preview</p>
          <div className="flex max-w-3xl flex-col gap-4">
            <h1 className="text-balance text-4xl font-semibold sm:text-5xl">
              Everything you need to build with proompteng
            </h1>
            <p className="text-base text-fd-muted-foreground sm:text-lg">
              Welcome to the home for the proompteng platform. Discover how to orchestrate prompts, automate
              evaluations, and operate safely from development through to production.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/docs"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-fd-primary px-6 py-3 text-sm font-medium text-fd-primary-foreground shadow-sm transition hover:bg-fd-primary/90"
            >
              Read the docs
            </Link>
            <Link
              href="https://proompteng.ai"
              className="text-sm font-medium text-fd-foreground underline underline-offset-4"
            >
              Visit proompteng.ai
            </Link>
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Why teams choose proompteng</h2>
            <p className="text-sm text-fd-muted-foreground">
              A shared language for product, engineering, and safety teams to build prompt-driven features together.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {highlights.map((highlight) => (
              <div
                key={highlight.title}
                className="rounded-2xl border border-fd-border bg-fd-card p-6 text-left shadow-sm"
              >
                <h3 className="text-base font-semibold text-fd-foreground">{highlight.title}</h3>
                <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{highlight.description}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-10 lg:grid-cols-[1.2fr,0.8fr]">
          <div className="rounded-2xl border border-fd-border bg-fd-card p-8 shadow-sm">
            <h2 className="text-lg font-semibold">Quickstart</h2>
            <p className="mt-2 text-sm text-fd-muted-foreground">
              Follow the essentials to get a workspace online in minutes. Every step links deeper guidance inside the
              docs.
            </p>
            <ol className="mt-6 flex flex-col gap-5">
              {quickStartSteps.map((step) => (
                <li key={step.title} className="text-left">
                  <div className="text-sm font-medium text-fd-foreground">{step.title}</div>
                  <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{step.description}</p>
                  <code className="mt-3 inline-flex rounded-md border border-fd-border bg-fd-background px-3 py-1 text-xs font-medium text-fd-muted-foreground">
                    {step.code}
                  </code>
                </li>
              ))}
            </ol>
          </div>
          <div className="rounded-2xl border border-fd-border bg-fd-card p-8 shadow-sm">
            <h2 className="text-lg font-semibold">Dive deeper</h2>
            <p className="mt-2 text-sm text-fd-muted-foreground">
              Head straight to the topics people reference most during onboarding, reviews, and production launches.
            </p>
            <ul className="mt-6 flex flex-col gap-5">
              {resourceLinks.map((resource) => (
                <li key={resource.title} className="text-left">
                  <Link
                    href={resource.href}
                    className="text-sm font-medium text-fd-foreground transition hover:text-fd-primary"
                  >
                    {resource.title}
                  </Link>
                  <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{resource.description}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </main>
  )
}
