export const mechanics = [
  {
    name: 'Turn Structure',
    whyItMatters: 'Each turn converts movement into information, fights, mines, dwellings, and town timings.',
    decisions: [
      'What must the main hero do before ending turn?',
      'Which pickups can scouts handle?',
      'What build must be funded today?',
    ],
    mistakes: [
      'Ending with unused main-hero movement',
      'Buying army before seeing the route',
      'Taking fights that delay the next objective',
    ],
  },
  {
    name: 'Adventure Movement',
    whyItMatters: 'Movement is the real currency behind first-week tempo and contested objectives.',
    decisions: [
      'Road or terrain shortcut?',
      'Main hero or scout pickup?',
      'Fight now or preserve movement for a mine?',
    ],
    mistakes: [
      'Wandering for minor resources',
      'Splitting army before a guard fight',
      'Missing native terrain advantages',
    ],
  },
  {
    name: 'Scouting',
    whyItMatters: 'Scouting prevents dead routes and tells you which mines, banks, and towns are worth committing to.',
    decisions: [
      'What must be revealed before the next build?',
      'Can a scout safely chain resources?',
      'Where is the opponent likely to appear?',
    ],
    mistakes: [
      'Using the main hero as a slow scout',
      'Ignoring roads and portals',
      'Leaving fog around contested objects',
    ],
  },
  {
    name: 'Economy',
    whyItMatters:
      'Gold and rare resources only matter when they arrive before a dwelling, upgrade, spell, or fight timing.',
    decisions: [
      'Which mine pays back soonest?',
      'Which building unlocks weekly value?',
      'Can recruitment wait one day?',
    ],
    mistakes: [
      'Saving resources with no timing plan',
      'Building late economy in a tempo game',
      'Recruiting units that cannot reach the fight',
    ],
  },
  {
    name: 'Town Builds',
    whyItMatters: 'Town decisions compound weekly through creature growth, magic access, and defense.',
    decisions: ['Core dwelling or economy?', 'Upgrade before or after recruitment?', 'Magic guild or army building?'],
    mistakes: [
      'Building a perfect late town while losing map control',
      'Skipping growth that would change the next neutral fight',
    ],
  },
  {
    name: 'Creature Growth',
    whyItMatters: 'Growth is recurring power, but only if the units can join the route in time.',
    decisions: [
      'Which dwelling changes week two?',
      'Which stacks must never be traded?',
      'Can an upgrade create a speed breakpoint?',
    ],
    mistakes: ['Buying every stack instead of the needed stack', 'Sacrificing elite growth in avoidable fights'],
  },
  {
    name: 'Combat Initiative',
    whyItMatters: 'Speed and initiative decide who blocks, shoots, casts, retaliates, or dies first.',
    decisions: [
      'Which enemy stack acts before yours?',
      'Which unit must be blocked?',
      'Can a wait/defend line save a stack?',
    ],
    mistakes: [
      'Reading damage without turn order',
      'Letting enemy fast stacks reach shooters',
      'Wasting a high-speed blocker',
    ],
  },
  {
    name: 'Damage And Retaliation',
    whyItMatters: 'Good fights are won by killing priority stacks while avoiding expensive retaliation.',
    decisions: ['Can the stack kill cleanly?', 'Is retaliation acceptable?', 'Which cheap unit can absorb the hit?'],
    mistakes: [
      'Taking max-loss trades for small rewards',
      'Ignoring ranged penalties',
      'Damaging too many targets instead of killing one',
    ],
  },
  {
    name: 'Focus, Morale, And Luck',
    whyItMatters:
      'Tempo swings from focus abilities, morale turns, and lucky damage can decide neutral fights and PvP exchanges.',
    decisions: [
      'Which ability must be saved?',
      'What happens if morale triggers?',
      'Does luck create a kill breakpoint?',
    ],
    mistakes: ['Spending focus before the decisive stack', 'Planning only around average damage'],
  },
  {
    name: 'Magic And Mana',
    whyItMatters: 'A spell is valuable when it saves army, kills a stack, denies action, or unlocks a route.',
    decisions: [
      'Which spell changes losses?',
      'Can mana last through the route?',
      'Does spell power matter more than extra troops?',
    ],
    mistakes: ['Casting because mana is available', 'Choosing flashy spells over army preservation'],
  },
  {
    name: 'Artifacts And Items',
    whyItMatters: 'Items change movement, combat math, spell access, economy, and hero jobs.',
    decisions: [
      'Which hero uses this slot now?',
      'Does the artifact repay its guard cost?',
      'Is the set bonus realistic this game?',
    ],
    mistakes: ['Keeping route items on the wrong hero', 'Taking guarded artifacts that damage the main army too much'],
  },
  {
    name: 'Laws And Faction Development',
    whyItMatters: 'Laws should reinforce the map state, not a fantasy build order.',
    decisions: [
      'Does this law accelerate today’s bottleneck?',
      'Does it support the army actually being built?',
      'Will the payoff arrive before contact?',
    ],
    mistakes: ['Choosing a powerful late law while losing first-contact tempo'],
  },
  {
    name: 'Map Objects',
    whyItMatters:
      'Mines, banks, shrines, dwellings, and portals are only good when reward beats guard and movement cost.',
    decisions: [
      'What reward repeats?',
      'What guard losses are acceptable?',
      'Does this object position the hero for the next objective?',
    ],
    mistakes: ['Clearing shiny objects off-route', 'Letting scouts ignore safe pickups'],
  },
  {
    name: 'Siege And Town Defense',
    whyItMatters:
      'Town fights are timing checks: walls and towers help only if the army, hero, and spell plan can use them.',
    decisions: [
      'Can the defender stall?',
      'Which stack must protect shooters?',
      'Is the town worth abandoning to preserve main army?',
    ],
    mistakes: ['Overbuilding defense with no army', 'Returning too late to defend recruitment'],
  },
] as const

export const townBuildBranches = [
  {
    faction: 'Temple',
    identity: 'Stable ranged pressure, defensive bodies, and magic-supported trades.',
    opening: [
      'Secure gold and core dwellings',
      'Protect Crossbowman-style ranged pressure',
      'Use magic/economy when it arrives before week-two fights',
    ],
    branches: [
      'Town hall / treasury',
      'Core dwelling chain',
      'Ranged upgrade timing',
      'Mage guild',
      'Walls if contact is near',
    ],
  },
  {
    faction: 'Necropolis',
    identity: 'Attrition, undead conversion, and preserving irreplaceable high-value stacks.',
    opening: [
      'Open with repeatable growth',
      'Convert or preserve cheap bodies',
      'Delay risky elite trades until support is ready',
    ],
    branches: ['Undead Transformer', 'Skeleton/Wight line', 'Magic support', 'Treasury', 'Elite dwelling chain'],
  },
  {
    faction: 'Grove',
    identity: 'Fast route control, flexible ranged/forest units, and movement-sensitive fights.',
    opening: [
      'Prioritize route-enabling growth',
      'Keep fast stacks alive',
      'Use economy only when it accelerates creature timing',
    ],
    branches: ['Core dwellings', 'Movement/native terrain support', 'Magic utility', 'Treasury', 'Thunder/elite line'],
  },
  {
    faction: 'Dungeon',
    identity: 'Underground pressure, utility stacks, and dangerous tempo fights.',
    opening: [
      'Build cheap control bodies',
      'Protect fragile damage',
      'Use upgrades when they create reach or kill breakpoints',
    ],
    branches: ['Warren line', 'Resource depot', 'Magic/control support', 'Treasury', 'Elite monster chain'],
  },
  {
    faction: 'Hive',
    identity: 'Swarm growth, aggressive pressure, and compounding stack numbers.',
    opening: [
      'Get repeatable growth online',
      'Avoid wasting swarm bodies before power timing',
      'Use economy to keep recruitment continuous',
    ],
    branches: [
      'Low-tier dwelling chain',
      'Swarm/faction mechanic support',
      'Treasury',
      'Combat upgrades',
      'Elite line',
    ],
  },
  {
    faction: 'Schism',
    identity: 'Cult, abyssal, and law/magic pressure with punishing specialist stacks.',
    opening: [
      'Decide caster versus combat route early',
      'Build toward the specialist stack that solves the map',
      'Keep mana and faction law choices aligned',
    ],
    branches: [
      'Abyssal Remnant / main town chain',
      'Aga’Shoth-style cavalry line',
      'Magic guild',
      'Faction law support',
      'Defense if portal contact is likely',
    ],
  },
] as const
