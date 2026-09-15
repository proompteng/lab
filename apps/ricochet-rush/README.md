# Ricochet Rush

Ricochet Rush is a third-person survival shooter built with Godot 4.7.2. A close shoulder camera follows the player through an industrial chamber. Move relative to the camera, look freely with the mouse, and fire through the center crosshair. Survive escalating waves of four enemy types, collect XP upgrades, and summon a Time Echo to repeat your previous attack while you fight from another angle.

The game uses original articulated mech models and an industrial chamber authored in Blender. The committed GLBs include armor shells, joints, pipes, wall structures, and overhead machinery. Sky reflections, practical lights, and shadows give metal surfaces depth. Cyan marks Time Echoes. Inter is bundled with its SIL Open Font License 1.1 notice in `assets/fonts/`; the Godot MIT license notice is included at `assets/Godot-LICENSE.txt`.

## Controls

| Action              | Input                   |
| ------------------- | ----------------------- |
| Move                | `WASD` or arrow keys    |
| Look and aim        | Mouse                   |
| Fire                | Hold left mouse button  |
| Precision aim       | Hold right mouse button |
| Summon Time Echo    | `E`                     |
| Dash                | `Space`                 |
| Pause or resume     | `Esc`                   |
| Choose upgrade      | `1`, `2`, or `3`        |
| Toggle sound        | `M`                     |
| Restart after a run | `R`                     |

Runs last until the player dies. Each wave introduces pressure from four enemy types; XP upgrades, bouncing bullets, and score multipliers reward aggressive movement and clean chains.

Starting or resuming a run requests mouse capture. `Esc` pauses and releases it; switching away also pauses the game. If an embedded browser rejects capture, the game stays playable with right mouse held while dragging to look and aim; the on-screen controls change to show this mode. The camera contracts against walls, and bullets are checked from the weapon to the crosshair target so nearby cover cannot be bypassed with the shoulder view. Right mouse narrows the view for precision aiming.

Time Echoes become available after at least `0.65` seconds of recorded play. Press `E` to summon a cyan copy that replays the last three seconds of movement, three-dimensional aim, and actual shots while you keep playing. Echoes have a six-second cooldown. Hit the same enemy with both bodies within `1.2` seconds to trigger the `SYNC` kill bonus.

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

`make check` imports the project in a headless editor, checks every GDScript with `gdformat` and `gdlint` from pinned `gdtoolkit==4.5.0`, then runs combat, echo, camera, model articulation, and game acceptance tests at a fixed 60 FPS. Godot exit status and error output are checked so script failures cannot silently pass. Matching Godot export templates are required for the export targets.

Builds are written below `build/`, with the browser entry point at `build/web/index.html` and the macOS distribution as the zipped archive `build/macos/RicochetRush.zip`.

The [model reference sheet and full generation prompt](art/concepts/README.md) define the original actor silhouettes. To regenerate the Blender-authored GLBs locally, use Blender 5.2.1 with `blender` on `PATH` and run `make art`; CI uses the committed models and does not install Blender. The concept image and editable Blender source stay outside the runtime exports.

### Optional Blender MCP setup

The editable Blender scene can optionally be inspected and adjusted through the third-party [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) bridge. With `uv` installed, pin the bridge version when installing its Blender addon:

```sh
uvx --from "blender-mcp==1.9.1" blender-mcp install-addon
```

Enable `MCP for Blender` in Blender, then configure your MCP client to launch `uvx --from "blender-mcp==1.9.1" blender-mcp` and start the local addon server. A client configuration can set `BLENDER_HOST=localhost`, `BLENDER_PORT=9876`, `BLENDER_MCP_SAFE_MODE=1`, and `DISABLE_TELEMETRY=true`; no project secrets or machine-specific paths are required. MCP is optional: Blender edits `art/source/ricochet_set.blend` and regenerates the committed GLBs, while Godot runs real-time gameplay. CI only consumes those committed GLBs and does not install Blender or MCP.
