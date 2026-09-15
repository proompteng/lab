export type Benefit = {
  icon:
    | 'Layers'
    | 'Cloud'
    | 'Activity'
    | 'Boxes'
    | 'Eye'
    | 'Server'
    | 'Database'
    | 'ShieldCheck'
    | 'KeyRound'
    | 'Lock'
    | 'Network'
    | 'Brain'
  title: string
  text: string
}

export type CardItem = {
  icon?: Benefit['icon']
  title: string
  text: string
}

export type HeroHighlight = {
  title: string
  description: string
}

export type Metric = {
  value: string
  label: string
  sublabel: string
}

export type SocialProof = {
  name: string
  tagline: string
}

export type PlaybookStep = {
  title: string
  description: string
  timeframe: string
  result: string
}

export type FaqItem = {
  question: string
  answer: string
}

export type ComparisonPoint = {
  capability: string
  proompteng: string
  salesforceAgentforce: string
  googleGemini: string
}

export type HeroContent = {
  announcement?: {
    label: string
    href: string
  }
  headline: string
  subheadline: string
  ctaLabel: string
  ctaHref: string
  secondaryCtaLabel: string
  secondaryCtaHref: string
  deRisk: string
  highlights: HeroHighlight[]
}

export type SectionIntro = {
  kicker: string
  heading: string
  description: string
}

export type ShowcaseSection = {
  id: string
  kicker: string
  heading: string
  description: string
  items: CardItem[]
}

export type LandingContent = {
  hero: HeroContent
  benefits: SectionIntro & { items: Benefit[] }
  controlPlane: SectionIntro & {
    comparisonHeading: string
    comparisonNote: string
    points: ComparisonPoint[]
  }
  socialProof: SectionIntro & { items: SocialProof[] }
  metrics: SectionIntro & { items: Metric[] }
  showcase: { sections: ShowcaseSection[] }
  useCases: { title: string; items: CardItem[] }
  modelCatalog: { title: string; items: CardItem[] }
  playbook: SectionIntro & { steps: PlaybookStep[] }
  testimonial: { kicker: string; quote: string; author: string; org: string }
  faq: SectionIntro & { items: FaqItem[] }
  closingCta: {
    kicker: string
    heading: string
    description: string
    primaryCtaLabel: string
    primaryCtaHref: string
    secondaryCtaLabel: string
    secondaryCtaHref: string
    deRisk: string
  }
}

export const DEFAULT_LANDING_CONTENT: LandingContent = {
  hero: {
    announcement: {
      label: 'Docs and onboarding guide are live',
      href: 'https://docs.proompteng.ai',
    },
    headline: 'A calm, practical control plane for AI agents',
    subheadline:
      'proompteng helps platform and security teams ship agents safely. Policies, observability, and model routing live in one place so you can move without guesswork.',
    ctaLabel: 'Talk to us',
    ctaHref: 'mailto:greg@proompteng.ai',
    secondaryCtaLabel: 'See the docs',
    secondaryCtaHref: 'https://docs.proompteng.ai',
    deRisk: 'early access - self-hosting available - hands-on support',
    highlights: [
      {
        title: 'Readable policy checks',
        description: 'Write rules in code and review them in Git.',
      },
      {
        title: 'Trace every run',
        description: 'See what the agent did and why.',
      },
      {
        title: 'Model choice',
        description: 'Use OpenAI, Anthropic, Gemini, or your own models.',
      },
    ],
  },
  benefits: {
    kicker: 'built for platform teams',
    heading: 'What you get on day one',
    description: 'A control plane that fits your stack and keeps policy, routing, and visibility in sync.',
    items: [
      {
        icon: 'Layers',
        title: 'Works with your tools',
        text: 'Drop in without rewriting core services.',
      },
      {
        icon: 'Cloud',
        title: 'Runs in your cloud',
        text: 'Deploy SaaS or self-hosted where your data lives.',
      },
      {
        icon: 'Eye',
        title: 'Visibility built in',
        text: 'Traces, replay, and audit-ready logs.',
      },
      {
        icon: 'ShieldCheck',
        title: 'Clear guardrails',
        text: 'Policy checks that teams can review and approve.',
      },
      {
        icon: 'Boxes',
        title: 'Flexible models',
        text: 'Swap providers without changing application code.',
      },
      {
        icon: 'Database',
        title: 'Memory + retrieval',
        text: 'Connect to the stores you already trust.',
      },
    ],
  },
  controlPlane: {
    kicker: 'control plane basics',
    heading: 'What we mean by a control plane',
    description:
      'It is the layer that decides what agents can do, routes models, and records outcomes. proompteng keeps that layer explicit and easy to inspect.',
    comparisonHeading: 'How we compare (high level)',
    comparisonNote: 'Need a deeper look? Ask for the governance checklist.',
    points: [
      {
        capability: 'Policies and approvals',
        proompteng: 'Git-based policies and explicit approvals.',
        salesforceAgentforce: 'Focused on Salesforce flows and tooling.',
        googleGemini: 'Depends on custom middleware and IAM rules.',
      },
      {
        capability: 'Model routing',
        proompteng: 'Choose models by cost, latency, or task.',
        salesforceAgentforce: 'Optimized for Salesforce-native models.',
        googleGemini: 'Centered on Gemini within GCP.',
      },
      {
        capability: 'Observability',
        proompteng: 'Traces, replay, and run history in one view.',
        salesforceAgentforce: 'Basic monitoring across Salesforce surfaces.',
        googleGemini: 'Logging via Cloud Logging with extra setup.',
      },
      {
        capability: 'Deployment options',
        proompteng: 'SaaS or self-hosted by request.',
        salesforceAgentforce: 'Salesforce cloud only.',
        googleGemini: 'Google Cloud only.',
      },
    ],
  },
  socialProof: {
    kicker: 'design partners',
    heading: 'Built alongside real teams',
    description: 'We work with small groups who need control, not hype.',
    items: [
      { name: 'Fintech platform team', tagline: 'audit-ready agent rollouts' },
      { name: 'Biotech ops team', tagline: 'regulated workflows with clear approvals' },
      { name: 'Logistics team', tagline: 'agent-assisted dispatch and routing' },
      { name: 'Security org', tagline: 'policy reviews and incident replay' },
      { name: 'Product design group', tagline: 'safe experimentation with AI copilots' },
      { name: 'Enterprise IT', tagline: 'centralized model routing' },
    ],
  },
  metrics: {
    kicker: 'outcomes we track',
    heading: 'Fewer surprises, clearer decisions',
    description: 'These are the outcomes teams tend to care about first.',
    items: [
      {
        value: 'Less rework',
        label: 'policy clarity',
        sublabel: 'Policies stay close to code and are easy to review.',
      },
      {
        value: 'Fewer blind spots',
        label: 'run visibility',
        sublabel: 'Trace what happened and share it with stakeholders.',
      },
      {
        value: 'Lower waste',
        label: 'model spend',
        sublabel: 'Route tasks to the right model for the job.',
      },
    ],
  },
  showcase: {
    sections: [
      {
        id: 'governance',
        kicker: 'policy + control',
        heading: 'Keep guardrails simple',
        description: 'Define what agents can do and keep approvals visible.',
        items: [
          {
            icon: 'Network',
            title: 'Policy routing',
            text: 'Route by policy, not scattered config files.',
          },
          {
            icon: 'Activity',
            title: 'Approvals',
            text: 'Human-in-the-loop for sensitive actions.',
          },
          {
            icon: 'Boxes',
            title: 'Tool registry',
            text: 'Track which tools are in use and why.',
          },
        ],
      },
      {
        id: 'integrations',
        kicker: 'connect your stack',
        heading: 'Work with the tools you already have',
        description: 'Plug into models, stores, and frameworks without rewrites.',
        items: [
          {
            icon: 'Database',
            title: 'Memory + RAG',
            text: 'Connect vector stores and search safely.',
          },
          {
            icon: 'Brain',
            title: 'Frameworks',
            text: 'Use LangGraph, LangChain, Vercel AI SDK, and more.',
          },
          {
            icon: 'Server',
            title: 'Self-hosted models',
            text: 'Bring your own weights when needed.',
          },
        ],
      },
      {
        id: 'observability',
        kicker: 'trust the output',
        heading: 'See what happened, end to end',
        description: 'Traces and replay make agent behavior explainable.',
        items: [
          {
            icon: 'Eye',
            title: 'Tracing',
            text: 'OpenTelemetry-compatible traces and logs.',
          },
          {
            icon: 'ShieldCheck',
            title: 'Audit trails',
            text: 'Keep a clear record of decisions and changes.',
          },
        ],
      },
    ],
  },
  useCases: {
    title: 'Common use cases',
    items: [
      {
        icon: 'ShieldCheck',
        title: 'Regulated workflows',
        text: 'Support agents where approvals matter.',
      },
      {
        icon: 'Activity',
        title: 'Ops automation',
        text: 'Coordinate tasks without losing oversight.',
      },
      {
        icon: 'Eye',
        title: 'Agent observability',
        text: 'Replay decisions and improve quality over time.',
      },
      {
        icon: 'Server',
        title: 'Self-hosted agents',
        text: 'Keep sensitive data inside your VPC.',
      },
      {
        icon: 'Network',
        title: 'Model routing',
        text: 'Pick the right model for each task.',
      },
      {
        icon: 'Database',
        title: 'Governed retrieval',
        text: 'Connect memory stores with clear retention rules.',
      },
    ],
  },
  modelCatalog: {
    title: 'Model coverage (examples)',
    items: [
      {
        icon: 'Brain',
        title: 'Frontier models',
        text: 'OpenAI, Anthropic, Gemini, and more.',
      },
      {
        icon: 'Server',
        title: 'Open weights',
        text: 'Llama, Mistral, Qwen, and similar.',
      },
      {
        icon: 'Database',
        title: 'Embeddings + rerankers',
        text: 'Use the providers you already trust.',
      },
    ],
  },
  playbook: {
    kicker: 'launch playbook',
    heading: 'A straightforward rollout path',
    description: 'Start small, then tighten governance as you scale.',
    steps: [
      {
        title: 'Connect the stack',
        description: 'Register tools, models, and data sources.',
        timeframe: 'Step 1',
        result: 'Agents can run with basic policy checks.',
      },
      {
        title: 'Add observability',
        description: 'Enable traces and run history.',
        timeframe: 'Step 2',
        result: 'You can review what happened and why.',
      },
      {
        title: 'Tighten guardrails',
        description: 'Add approvals and policy enforcement.',
        timeframe: 'Step 3',
        result: 'Sensitive actions are reviewed before they execute.',
      },
      {
        title: 'Scale intentionally',
        description: 'Expand to more agents and teams with confidence.',
        timeframe: 'Step 4',
        result: 'Governance scales with usage.',
      },
    ],
  },
  testimonial: {
    kicker: 'design partner note',
    quote: 'It feels grounded. We can see what the agent did and explain it internally.',
    author: 'Platform lead',
    org: 'Design partner',
  },
  faq: {
    kicker: 'questions',
    heading: 'A few common questions',
    description: 'If you want details, we are happy to walk through it.',
    items: [
      {
        question: 'Does this work with our existing LLM provider?',
        answer: 'Yes. You can register providers and route by policy.',
      },
      {
        question: 'Can we self-host?',
        answer: 'Yes. We support self-hosted deployments for teams that need it.',
      },
      {
        question: 'What does onboarding look like?',
        answer: 'We start with a short setup and a guided walkthrough.',
      },
      {
        question: 'How do you handle security?',
        answer: 'We focus on clear policies, scoped access, and audit logs.',
      },
    ],
  },
  closingCta: {
    kicker: 'ready to talk?',
    heading: 'Get a clear view of your agent stack',
    description: 'We will help you set guardrails and ship with confidence.',
    primaryCtaLabel: 'Talk to us',
    primaryCtaHref: 'mailto:greg@proompteng.ai',
    secondaryCtaLabel: 'Book a short call',
    secondaryCtaHref: 'mailto:greg@proompteng.ai?subject=Architecture%20Review',
    deRisk: 'no hard sell - practical guidance - fast feedback',
  },
}
