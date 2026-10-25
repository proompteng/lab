# Orbit Salvage

Orbit Salvage is a small, keyboard-first salvage game built with Godot 4.7.2. Pilot a tug from the station, tether cargo, avoid asteroid hazards, and bring valuable freight home for credits. The first playable loop includes twelve cargo targets, docking sales and repairs, a contract win or retry, persisted best credits, and a sound option.

The game uses original procedural visuals and audio. The bundled DM Mono and Space Grotesk fonts are distributed under the SIL Open Font License 1.1; their license texts are beside the font files in `assets/fonts/`.

## Controls

| Action                         | Keyboard              |
| ------------------------------ | --------------------- |
| Thrust forward                 | `W` or Up             |
| Thrust reverse                 | `S` or Down           |
| Rotate left or right           | `A`/Left or `D`/Right |
| Brake                          | `Space`               |
| Tether or release cargo        | `E`                   |
| Boost                          | `Shift`               |
| Upgrade thrusters while docked | `U`                   |
| Pause or resume                | `Esc`                 |
| Toggle sound                   | `M`                   |

The contract is complete after earning 1,200 credits; upgrade spending does not reduce that earned total. Thruster upgrades cost 300, 500, and 700 credits and are available at the station dock. When a controller is available, use the left stick to move and turn, `A` to brake, `X` to tether or release, the right shoulder button to boost, and `Start` to pause. Sound and upgrade actions remain on `M` and `U`.

## Development

The project expects Godot `4.7.2.stable.official.ed1daf0bf`. With Godot on `PATH`:

```sh
cd apps/orbit-salvage
make run
make editor
make check
make export-web
make export-macos
```

`make check` imports the project in a headless editor, checks every GDScript with `gdformat` and `gdlint` from pinned `gdtoolkit==4.5.0`, then runs `tests/physics_test.gd` and `tests/game_test.gd` at a fixed 60 FPS. The first check creates a local `.venv` and installs that exact toolkit version. Godot's matching export templates are required for the export targets.

Builds are written below `build/`, with the browser entry point at `build/web/index.html` and the macOS distribution as the zipped archive `build/macos/OrbitSalvage.zip`.
