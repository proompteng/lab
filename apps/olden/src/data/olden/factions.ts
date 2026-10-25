import type { Faction } from './schema'
import { currentVerification } from './sources'

export const factions = [
  {
    id: 'temple',
    name: 'Temple',
    nativeTerrain: 'Grass',
    identity: 'A balanced human army that rewards buffs, reliable creature roles, and clean fundamentals.',
    beginnerFit: 'easy',
    playstyleTags: ['balanced', 'buffs', 'durable army', 'straightforward tempo'],
    strengths: [
      'Clear melee, ranged, flyer, and elite stack roles.',
      'Positive effects convert ordinary trades into preserved army value.',
      'The faction teaches economy, town timing, and combat positioning without demanding unusual mechanics first.',
    ],
    weaknesses: [
      'Slow or wasteful early routing lets sharper factions outscale or outmaneuver it.',
      'Buff turns are weak if the army is already split, blocked, or trading into retaliation poorly.',
      'It can feel fair in fights where another faction is forcing unfair trades.',
    ],
    firstWeek: [
      'Secure wood and ore first so creature dwellings are not delayed.',
      'Fight with ranged pressure protected by durable bodies, not by spending elite stacks into retaliation.',
      'Build toward reliable weekly creature growth before expensive luxury upgrades.',
    ],
    combatPlan: [
      'Buff before committing fragile stacks.',
      'Use flyers and fast stacks to block shooters only when the counter-hit is worth it.',
      'Keep the main damage stack alive; Temple wins by compounding preserved army value.',
    ],
    counterplay: [
      'Force Temple to react on multiple fronts so its buffs cover only part of the army.',
      'Trade into low-value stacks before its elite units can decide the fight.',
      'Punish delayed economy; Temple is strongest when it reaches stable growth safely.',
    ],
    coreQuestions: [
      'Which stack gets the buff that decides this fight?',
      'Can this route preserve elite troops while still claiming mines and dwellings?',
      'Is the town building toward growth or only short-term comfort?',
    ],
    verification: currentVerification,
  },
  {
    id: 'necropolis',
    name: 'Necropolis',
    nativeTerrain: 'Deathland',
    identity:
      'An undead attrition faction that turns efficient fights and casualty management into long-game pressure.',
    beginnerFit: 'medium',
    playstyleTags: ['undead', 'attrition', 'reanimation', 'snowball'],
    strengths: [
      'Morale-neutral undead troops remove one volatility layer from combat planning.',
      'Early neutral fights can become future army value when casualties are managed well.',
      'The faction pressures opponents who take too many small losses.',
    ],
    weaknesses: [
      'Bad early fights slow both the army and the reanimation curve.',
      'It is easy to overvalue attrition and undervalue map tempo.',
      'Opponents can target key stacks before the snowball becomes visible.',
    ],
    firstWeek: [
      'Take fights that feed the army without sacrificing rare stacks.',
      'Prioritize economy routes that keep the main hero fighting every turn.',
      'Avoid unnecessary retreats; every lost tempo turn delays the attrition engine.',
    ],
    combatPlan: [
      'Preserve the stacks that convert combat wins into map momentum.',
      'Let expendable bodies absorb hits when that protects better growth units.',
      'Fight repeatedly only when the reward chain is better than resting or rerouting.',
    ],
    counterplay: [
      'Deny easy neutral chains and force expensive fights.',
      'Target the stacks that make future fights cheaper, not only the current highest damage unit.',
      'Race economy and objectives before Necropolis turns repeated small wins into a decisive army.',
    ],
    coreQuestions: [
      'Does this battle feed the snowball or just spend it?',
      'Can the hero keep fighting next turn with enough army left?',
      'Which enemy stack makes future Necropolis fights too easy if it survives?',
    ],
    verification: currentVerification,
  },
  {
    id: 'grove',
    name: 'Grove',
    nativeTerrain: 'Autumn',
    identity: 'A nature and fae faction about movement, growth, and turning map flow into combat advantages.',
    beginnerFit: 'medium',
    playstyleTags: ['nature', 'mobility', 'tempo', 'positioning'],
    strengths: [
      'Strong map-flow identity rewards good routing and town connection choices.',
      'Creature roles support flexible defensive and tempo play.',
      'It can protect economy while still contesting objectives when movement tools are used well.',
    ],
    weaknesses: [
      'Mistimed movement advantages do not matter if fights are taken in the wrong order.',
      'Fragile or specialist stacks can disappear if they are used as generic blockers.',
      'The faction asks players to read the map earlier than Temple does.',
    ],
    firstWeek: [
      'Reveal roads, portals, and safe resource chains before committing to a distant route.',
      'Avoid scattering the army across heroes before the main route is stable.',
      'Use defensive terrain and movement to choose fights, not to run away from every fight.',
    ],
    combatPlan: [
      'Win by arriving with the right stacks and taking favorable trades.',
      'Protect specialist units until they produce tempo or control value.',
      'Use movement advantages to threaten resources and towns while avoiding low-value brawls.',
    ],
    counterplay: [
      'Force Grove to defend fixed points so movement tools lose value.',
      'Punish split armies and overextended heroes.',
      'Take fights before Grove has arranged the terrain and initiative it wants.',
    ],
    coreQuestions: [
      'Does this move create a future resource, fight, or town timing?',
      'Which path lets the army fight while still collecting growth?',
      'Can the opponent force a fixed battle before Grove is ready?',
    ],
    verification: currentVerification,
  },
  {
    id: 'dungeon',
    name: 'Dungeon',
    nativeTerrain: 'Dirt',
    identity:
      'A dark elf and underground faction built around flexible attacks, high-ceiling tactics, and decisive trades.',
    beginnerFit: 'hard',
    playstyleTags: ['versatile', 'dark elves', 'dragons', 'tactical ceiling'],
    strengths: [
      'Flexible attack patterns let Dungeon punish poor formation.',
      'High-impact stacks can decide fights quickly when protected.',
      'Good players can convert positioning details into large trade advantages.',
    ],
    weaknesses: [
      'Mispositioning wastes the faction advantage faster than with simpler armies.',
      'Expensive key stacks make bad trades painful.',
      'The faction requires matchup knowledge to know which option is actually unfair.',
    ],
    firstWeek: [
      'Scout enough to choose fights where special attacks matter.',
      'Do not buy every shiny upgrade before the core army and economy are stable.',
      'Protect damage stacks from retaliation traps and enemy control.',
    ],
    combatPlan: [
      'Attack from angles that deny the enemy clean retaliation or follow-up.',
      'Use the hero and fastest stacks to isolate the most dangerous enemy unit.',
      'Commit elite damage only when the next enemy action is known.',
    ],
    counterplay: [
      'Keep formations compact enough that flexible attacks do not get premium targets.',
      'Trade into key stacks before Dungeon can set up a perfect angle.',
      'Pressure economy; Dungeon mistakes are expensive.',
    ],
    coreQuestions: [
      'Which attack option denies the enemy response?',
      'Can the main stack survive after committing?',
      'Is this fight being won by tactics or only by spending expensive army value?',
    ],
    verification: currentVerification,
  },
  {
    id: 'hive',
    name: 'Hive',
    nativeTerrain: 'Lava',
    identity:
      'A demonic insectoid swarm faction that rewards synergy, pressure, and committing before opponents stabilize.',
    beginnerFit: 'hard',
    playstyleTags: ['swarm', 'pressure', 'synergy', 'commitment'],
    strengths: [
      'Mono-faction and colony-style synergies can make the whole army faster and more dangerous.',
      'Pressure forces opponents to answer before their ideal build is ready.',
      'Distinct creature roles reward planning around the whole army rather than one star stack.',
    ],
    weaknesses: [
      'Broken synergy makes individual units feel underwhelming.',
      'Overcommitting into a prepared army can lose the pressure window instantly.',
      'The faction asks players to understand timing before they have many games played.',
    ],
    firstWeek: [
      'Keep the core army together until the synergy plan is clear.',
      'Choose fights that maintain pressure without gutting stack count.',
      'Build economy only as far as it supports the next timing attack.',
    ],
    combatPlan: [
      'Use speed and synergy to create first-hit value.',
      'Commit when multiple stacks can follow up, not when one stack is isolated.',
      'Preserve enough bodies for swarm bonuses to stay meaningful.',
    ],
    counterplay: [
      'Break Hive tempo with terrain, blockers, and high-value defensive trades.',
      'Force it to fight after synergy stacks have been thinned.',
      'Survive the pressure window and then punish its spent army.',
    ],
    coreQuestions: [
      'Is the army still reinforcing the swarm plan?',
      'Can pressure land before scaling factions stabilize?',
      'Which fight keeps enough stack mass for the next fight?',
    ],
    verification: currentVerification,
  },
  {
    id: 'schism',
    name: 'Schism',
    nativeTerrain: 'Snow',
    identity:
      'A control faction from the Depths of Water that denies abilities, disrupts spells, and summons pressure.',
    beginnerFit: 'hard',
    playstyleTags: ['denial', 'summons', 'battlefield control', 'sequencing'],
    strengths: [
      'Ability and spell denial can turn enemy power spikes into wasted turns.',
      'Summons and control effects reshape fights that looked equal on army count.',
      'It is strong into opponents who rely on one obvious tactical plan.',
    ],
    weaknesses: [
      'Sequencing mistakes are costly because denial must hit the right action.',
      'The faction can underperform if it only delays threats without converting advantage.',
      'Beginners may spend control on low-impact stacks.',
    ],
    firstWeek: [
      'Fight manually to learn which enemy actions must be denied.',
      'Use summons and control to preserve real army, not to extend bad fights.',
      'Prioritize hero development that makes control turns decisive.',
    ],
    combatPlan: [
      'Identify the enemy action that would swing the fight and deny that first.',
      'Convert disabled turns into stack kills or objective tempo.',
      'Do not spend control just because it is available; spend it when it changes the trade.',
    ],
    counterplay: [
      'Present multiple threats so Schism cannot deny all of them.',
      'Force early material trades before its control loop is ready.',
      'Bait denial on a medium threat, then commit the real damage stack.',
    ],
    coreQuestions: [
      'Which enemy action must be denied this round?',
      'Can summons convert control into material advantage?',
      'Is the fight being delayed or actually won?',
    ],
    verification: currentVerification,
  },
] satisfies Faction[]
