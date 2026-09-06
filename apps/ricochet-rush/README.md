# Ricochet Rush

Ricochet Rush is a short, replayable 3D survival shooter built with Godot 4.7.2. Move through a compact arena, aim with the mouse, and hold the left mouse button to fire bouncing rounds. Survive escalating waves of four enemy types, chain score combos, collect XP upgrades, and chase a persisted best score. When the arena gets crowded, summon a Time Echo to replay your recent attack from a second angle.

The game uses original procedural effects and committed GLB models. Its visual language is industrial: gunmetal, graphite, steel, and concrete-toned angular combat machines with restrained warm warning accents. Cyan is reserved for Time Echoes so the replay body reads immediately. Font binaries and their SIL Open Font License 1.1 notices are included beside the files in `assets/fonts/`; the Godot MIT license notice is included at `assets/Godot-LICENSE.txt`.

## Controls

| Action              | Input                     |
| ------------------- | ------------------------- |
| Move                | `WASD` or arrow keys      |
| Aim                 | Mouse                     |
| Fire                | Hold left mouse button    |
| Summon Time Echo    | `E` or right mouse button |
| Dash                | `Space`                   |
| Pause or resume     | `Esc`                     |
| Choose upgrade      | `1`, `2`, or `3`          |
| Toggle sound        | `M`                       |
| Restart after a run | `R`                       |

Runs last until the player dies. Each wave introduces pressure from four enemy types; XP upgrades, bouncing bullets, and score multipliers reward aggressive movement and clean chains.

Time Echoes become available after at least `0.65` seconds of recorded play. Press `E` or right mouse button to summon a cyan copy that replays the last three seconds of your movement, aim, and shots while you keep playing. Echoes have a six-second cooldown. Hit the same enemy with both bodies within `1.2` seconds to trigger the `SYNC` kill bonus.

## Development

The project expects Godot `4.7.2.stable.official.ed1daf0bf`. With Godot on `PATH`:

```sh
cd apps/ricochet-rush
make run
make editor
make check
make export-web
make export-macos
```

`make check` imports the project in a headless editor, checks every GDScript with `gdformat` and `gdlint` from pinned `gdtoolkit==4.5.0`, then runs `tests/combat_test.gd`, `tests/echo_test.gd`, and `tests/game_test.gd` at a fixed 60 FPS. Godot exit status and error output are checked so script failures cannot silently pass. Matching Godot export templates are required for the export targets.

Builds are written below `build/`, with the browser entry point at `build/web/index.html` and the macOS distribution as the zipped archive `build/macos/RicochetRush.zip`.

To regenerate the Blender-authored GLBs locally, use Blender 5.2.1 with `blender` on `PATH` and run `make art`; CI uses the committed models and does not install Blender.

### Optional Blender MCP setup

The editable Blender scene can optionally be inspected and adjusted through the third-party [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) bridge. With `uv` installed, pin the bridge version when installing its Blender addon:

```sh
uvx --from "blender-mcp==1.9.1" blender-mcp install-addon
```

Enable `MCP for Blender` in Blender, then configure your MCP client to launch `uvx --from "blender-mcp==1.9.1" blender-mcp` and start the local addon server. A client configuration can set `BLENDER_HOST=localhost`, `BLENDER_PORT=9876`, `BLENDER_MCP_SAFE_MODE=1`, and `DISABLE_TELEMETRY=true`; no project secrets or machine-specific paths are required. MCP is optional: Blender edits `art/source/ricochet_set.blend` and regenerates the committed GLBs, while Godot runs real-time gameplay. CI only consumes those committed GLBs and does not install Blender or MCP.
