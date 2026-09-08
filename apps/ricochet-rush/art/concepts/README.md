# Model reference

`mech-model-sheet-v1.png` is the original generated design reference for the third-person model rebuild. The sheet was generated with the built-in image-generation tool before rebuilding the models against it. It is a modeling reference, not an in-game render or an imported 3D asset.

## Online references

- [Armored Core VI official assembly screenshots](https://www.bandainamcoent.com/news/armored-core-6-fires-of-rubicon-beginners-guide): studied layered armor, the relationship between large shells and exposed joints, and silhouette readability.
- [Titanfall 2 official Titan screenshots](https://www.ea.com/games/titanfall/titanfall-2/buy/addon/titanfall-2-prime-titan-bundle): studied manufactured plate shapes, narrow articulated waists, stable feet, and mechanical joints.
- [Boston Dynamics Atlas](https://bostondynamics.com/products/atlas/): consulted for industrial actuator and articulation context.

The references informed broad visual decisions. Their models, textures, logos, and characters are not bundled with the game.

## Generation prompt

```text
Use case: stylized-concept.
Asset type: a high-resolution production model sheet for ORIGINAL 3D combat mechs, to be modeled faithfully in Blender for a close third-person game. This is a design reference, not a game screenshot.
Create one landscape sheet on a neutral warm light-gray studio background, with realistic PBR 3D concept renders, clear readable silhouettes, small understated sans-serif labels, soft contact shadows and even studio lighting. Top two-thirds: THREE large consistent views of the SAME playable mech: front three-quarter, exact side, rear three-quarter. Bottom third: FOUR smaller enemy designs, each fully visible and separated, labeled CHASER, RUNNER, BRUTE, TURRET.
PLAYER: a sophisticated headless industrial biped, human-scale 1.85m, tall purposeful proportions, narrow articulated waist, powerful reverse-jointed legs, broad but shaped chest armor, no face or separate cartoon head. Single integrated right forearm cannon with a clear cylindrical muzzle at chest height; left forearm a small sloped armored guard. Off-white worn ceramic armor plates over graphite mechanical internals, dark gunmetal joints, subtle oxidized copper heat shielding, two recessed rear amber power cells. Armor uses carefully curved and tapered manufactured shells with chamfered perimeter edges, overlaps and panel gaps. Leg joints have circular bearings, pistons and cable loops. Layered shin armor and split stable feet. A recessed horizontal sensor strip in upper chest, no eyes or face. Backpack has practical cooling vents and a compact rectangular power unit. Main forms are deliberate and simple enough to build, with localized mechanical detail; not random greeble noise. The three views must preserve identical limb count, proportions, colors, weapon and armor design.
ENEMIES share the same industrial design language but clearly distinct silhouettes: CHASER a lean forward-canted biped with oxide-red sloping front ram armor and no hands; RUNNER a slender graphite reverse-jointed two-leg skirmisher with swept side fins and a narrow wedge body; BRUTE a wide heavy quadruped with thick dark olive sloped armor and dual short integrated weapon housings; TURRET a compact stationary three-legged gun emplacement with an elevated gun barrel and visible rotation bearing. All entirely mechanical, realistic surfaces and plausible joints.
Mood and quality: mature grounded science fiction, precise industrial design, confident silhouettes, tactile metal and ceramic, controlled weathering and fine edge wear. The visual standard is detailed modern third-person mech games; original designs, no existing game characters, symbols or logos. No cute robots, no toy proportions, no chibi, no rounded mascot heads, no simple cube-stack models, no neon candy colors, no unnecessary text, no busy environment, no cropped feet or weapons. Prioritize accurate modelable forms and consistency over cinematic effects.
```
