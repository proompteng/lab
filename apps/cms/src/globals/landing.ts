import type { Field, GlobalConfig } from 'payload'

const iconOptions = [
  'Layers',
  'Cloud',
  'Activity',
  'Boxes',
  'Eye',
  'Server',
  'Database',
  'ShieldCheck',
  'KeyRound',
  'Lock',
  'Network',
  'Brain',
]

const cardFields: Field[] = [
  {
    name: 'icon',
    type: 'select',
    required: false,
    options: iconOptions,
  },
  {
    name: 'title',
    type: 'text',
    required: true,
  },
  {
    name: 'text',
    type: 'textarea',
    required: true,
  },
]

const Landing: GlobalConfig = {
  slug: 'landing',
  label: 'Landing Page',
  access: {
    read: () => true,
  },
  fields: [
    {
      name: 'hero',
      type: 'group',
      fields: [
        {
          name: 'announcement',
          type: 'group',
          fields: [
            { name: 'label', type: 'text' },
            { name: 'href', type: 'text' },
          ],
        },
        { name: 'headline', type: 'text', required: true },
        { name: 'subheadline', type: 'textarea', required: true },
        { name: 'ctaLabel', type: 'text', required: true },
        { name: 'ctaHref', type: 'text', required: true },
        { name: 'secondaryCtaLabel', type: 'text', required: true },
        { name: 'secondaryCtaHref', type: 'text', required: true },
        { name: 'deRisk', type: 'text', required: true },
        {
          name: 'highlights',
          type: 'array',
          fields: [
            { name: 'title', type: 'text', required: true },
            { name: 'description', type: 'textarea', required: true },
          ],
        },
      ],
    },
    {
      name: 'benefits',
      type: 'group',
      fields: [
        { name: 'kicker', type: 'text', required: true },
        { name: 'heading', type: 'text', required: true },
        { name: 'description', type: 'textarea', required: true },
        {
          name: 'items',
          type: 'array',
          fields: cardFields,
        },
      ],
    },
    {
      name: 'controlPlane',
      type: 'group',
      fields: [
        { name: 'kicker', type: 'text', required: true },
        { name: 'heading', type: 'text', required: true },
        { name: 'description', type: 'textarea', required: true },
        { name: 'comparisonHeading', type: 'text', required: true },
        { name: 'comparisonNote', type: 'text', required: true },
        {
          name: 'points',
          type: 'array',
          fields: [
            { name: 'capability', type: 'text', required: true },
            { name: 'proompteng', type: 'textarea', required: true },
            { name: 'salesforceAgentforce', type: 'textarea', required: true },
            { name: 'googleGemini', type: 'textarea', required: true },
          ],
        },
      ],
    },
    {
      name: 'socialProof',
      type: 'group',
      fields: [
        { name: 'kicker', type: 'text', required: true },
        { name: 'heading', type: 'text', required: true },
        { name: 'description', type: 'textarea', required: true },
        {
          name: 'items',
          type: 'array',
          fields: [
            { name: 'name', type: 'text', required: true },
            { name: 'tagline', type: 'text', required: true },
          ],
        },
      ],
    },
    {
      name: 'metrics',
      type: 'group',
      fields: [
        { name: 'kicker', type: 'text', required: true },
        { name: 'heading', type: 'text', required: true },
        { name: 'description', type: 'textarea', required: true },
        {
          name: 'items',
          type: 'array',
          fields: [
            { name: 'value', type: 'text', required: true },
            { name: 'label', type: 'text', required: true },
            { name: 'sublabel', type: 'text', required: true },
          ],
        },
      ],
    },
    {
      name: 'showcase',
      type: 'group',
      fields: [
        {
          name: 'sections',
          type: 'array',
          fields: [
            { name: 'id', type: 'text', required: true },
            { name: 'kicker', type: 'text', required: true },
            { name: 'heading', type: 'text', required: true },
            { name: 'description', type: 'textarea', required: true },
            {
              name: 'items',
              type: 'array',
              fields: cardFields,
            },
          ],
        },
      ],
    },
    {
      name: 'useCases',
      type: 'group',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'items', type: 'array', fields: cardFields },
      ],
    },
    {
      name: 'modelCatalog',
      type: 'group',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'items', type: 'array', fields: cardFields },
      ],
    },
    {
      name: 'playbook',
      type: 'group',
      fields: [
        { name: 'kicker', type: 'text', required: true },
        { name: 'heading', type: 'text', required: true },
        { name: 'description', type: 'textarea', required: true },
        {
          name: 'steps',
          type: 'array',
          fields: [
            { name: 'title', type: 'text', required: true },
            { name: 'description', type: 'textarea', required: true },
            { name: 'timeframe', type: 'text', required: true },
            { name: 'result', type: 'text', required: true },
          ],
        },
      ],
    },
    {
      name: 'testimonial',
      type: 'group',
      fields: [
        { name: 'kicker', type: 'text', required: true },
        { name: 'quote', type: 'textarea', required: true },
        { name: 'author', type: 'text', required: true },
        { name: 'org', type: 'text', required: true },
      ],
    },
    {
      name: 'faq',
      type: 'group',
      fields: [
        { name: 'kicker', type: 'text', required: true },
        { name: 'heading', type: 'text', required: true },
        { name: 'description', type: 'textarea', required: true },
        {
          name: 'items',
          type: 'array',
          fields: [
            { name: 'question', type: 'text', required: true },
            { name: 'answer', type: 'textarea', required: true },
          ],
        },
      ],
    },
    {
      name: 'closingCta',
      type: 'group',
      fields: [
        { name: 'kicker', type: 'text', required: true },
        { name: 'heading', type: 'text', required: true },
        { name: 'description', type: 'textarea', required: true },
        { name: 'primaryCtaLabel', type: 'text', required: true },
        { name: 'primaryCtaHref', type: 'text', required: true },
        { name: 'secondaryCtaLabel', type: 'text', required: true },
        { name: 'secondaryCtaHref', type: 'text', required: true },
        { name: 'deRisk', type: 'text', required: true },
      ],
    },
  ],
}

export default Landing
