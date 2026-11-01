# Tengri browser and computer use

Chrome opens a persistent, headed Chromium browser in the owner's MicroVM. The separate Tengri application owns
Codex chat. Closing Chrome disconnects its preview and revokes the view grant. The browser process, cookies,
local storage, profile, and downloaded files remain in the guest until the guest stops. The profile and downloaded
files survive sleep and resume on the retained workspace.
The application split resets saved desktop window layouts; saved conversations and guest browser data remain intact.

## Research

The public product documentation establishes a shared computer experience. It does not identify the private
protocol or encoder used to stream the preview.

| Product     | Documented browser and preview behavior                                                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Dots | Each Dot has its own cloud computer. The profile opens a computer preview which the user can view and operate. Sensitive steps can hand control to the user. [OpenAI documentation](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot).                                                                                          |
| Grok Bot    | Bots share an account's persistent computer, files, cookies, and credentials. Each Bot has a separate screen, with one computer task at a time on that screen. Agent Computer shows live browser input and supports human takeover. The screens are not security isolation boundaries. [xAI documentation](https://docs.x.ai/grok-bot/computer-and-apps). |
| Meta Muse   | The agent has a persistent, isolated Linux environment and a full browser shared with the user. The user can intervene while work continues. [Meta documentation](https://ai.meta.com/muse/).                                                                                                                                                             |

Tengri uses this shared browser pattern with its existing owner MicroVM. TigerVNC and noVNC are Tengri's transport
choice. The public sources above do not establish that those products use VNC, WebRTC, or CDP.

## Browser display and identity

`IssueBrowserSession` checks the authenticated owner, opens the guest browser through `OpenBrowser`, and issues an
owner-bound preview grant for the reserved browser port `13339`. Generic workspace previews cannot select that
port. The grant bootstraps a cookie on its isolated preview origin. Chrome renders noVNC in an iframe on that origin.

Chrome and Code bind their preview origin to the login session, workspace, runtime epoch, desktop and window.
Their cookies and SQL leases last at most 30 minutes. The desktop renews halfway through the confirmed lease,
using a new authenticated launch ticket and the same origin. A hidden bootstrap frame replaces the HttpOnly cookie;
its acknowledgement must match the frame, origin, session ID and renewal nonce. Credentials never enter parent
messages. Code and Chrome keep their visible documents and established sockets. Chrome retains its
display of the same guest Chromium process, preserving tabs, form contents and takeover state.
New handshakes reject rotated credentials. Established sockets recheck the current lease's complete authority
binding and fresh Ofz policy every second; expiry, deletion or policy denial closes them within three seconds.
Renewal does not launch guest processes or touch the VM activity tracker. It uses the existing audited
control action and session idle policy; it cannot revive an expired session or extend its eight-hour maximum. Every launch, bootstrap and
subsequent connection still requires current Ofz authority; expiry, sign-out and policy revocation remain enforced.

Nanoagent forwards authenticated preview WebSocket traffic to TigerVNC's private Unix socket. TigerVNC exposes no
TCP listener. Its socket has mode `0600`, and the X display requires the guest's Xauthority cookie. The gateway
retains its origin checks, owner authorization, grant revocation, and SPIFFE mutual TLS to the slot supervisor. The
supervisor forwards to Nanoagent over the slot's private vsock with its exact claim identity. The browser
preview does not contain control-plane credentials.
The existing `RevokeEditorSessions` logout RPC now revokes every pending and active Chrome and editor preview for the authenticated owner before clearing
authentication. A revocation failure blocks sign-out; established browser WebSockets close after revocation.

Sites load inside Chromium. Their framing restrictions do not prevent normal browser navigation. Chromium owns
its native tabs, history, address bar, cookies, JavaScript, forms, and downloads. Its process keeps the user namespace
sandbox enabled. The display uses X11 at `:91`, resizes to the preview, and streams through
[noVNC's RFB client](https://novnc.com/noVNC/docs/API.html). Mac Command shortcuts delivered to the preview map to
Chromium's Linux Control shortcuts. The outer browser can reserve shortcuts such as Command-L; click the remote
address bar to navigate. Text paste uses the browser's clipboard permission, and received text has an explicit copy
control. The display does not forward audio.

## Persistent installation

The guest image includes a checksummed noVNC `1.7.0` client and bootstrap scripts. Playwright Core `1.59.1` selects
the Chromium build. The first launch installs the engine under `~/.tengri/browser` from Microsoft's browser download
service. APT verifies the Ubuntu graphics packages during the image build, and the image bundles the extracted
libraries in `browser-runtime.tar.xz`. The guest keys its private retained-home installation by the archive's SHA-256
hash. Cold guests therefore use the packages in their immutable image, even after Ubuntu removes superseded versions.
The graphics runtime has scoped library, font, and keyboard paths. The `xkbcomp` wrapper handles TigerVNC's
compiled absolute executable path.

The compressed graphics bundle fits inside the private 1.5 GiB root filesystem with enforced headroom; the expanded
runtime resides on the retained home. The image build verifies cold extraction without network access, then
validates the engine and extracted runtime through `browser-smoke`. A cold engine install requires network access to
the pinned Playwright package and Chromium download service. Startup failures remain visible and retryable.
Downloads use the owner's `Downloads` folder. Closing the desktop view does not erase the profile.

## Agent computer tool

Nanoagent registers `nanoagent browser-mcp` as a required server with each Codex app-server process. The 300-second
tool timeout covers a cold browser installation. These settings use [Codex's documented MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).
The stdio MCP server exposes one
`computer` tool with `screenshot`, `click`, `double_click`, `drag`, `scroll`, `key`, `type`, `navigate`, `status`, and `release`
actions. Each successful input action returns a screenshot and its dimensions. Coordinates include the native
browser toolbar. Input validation rejects missing coordinates, invalid buttons, unsupported key syntax, and
navigation URLs outside HTTP and HTTPS.
Large PNG screenshots use bounded JPEG encoding at the original resolution, keeping computer coordinates unchanged.
If screenshot capture fails after an input succeeds, the tool explicitly reports the completed action and the
observation failure so the agent can request a screenshot without repeating a potentially consequential input.

The MCP process reaches only the current guest's `~/.tengri/browser/control.sock`, with mode `0600`. It has no
control-plane connection or credentials. Actions serialize on the shared display. Each MCP client has its own random
driver identity. The first observation or input acquires exclusive agent control for five minutes, renewed on each
action. Other agents receive an explicit error until the owner uses `release`, disconnects its stdio server, or its
lease expires. `status` does not acquire or extend control. **Take control** clears the driver and pauses both
agent input and screenshots, including after guest restart. **Let agent use browser** returns control. The status
action remains available while the user has control.

Takeover is enforced by this computer tool. The agent already has shell access to its own guest, so takeover is
not an operating system isolation boundary against that shell. MCP instructions tell the agent to respect takeover,
treat page contents as untrusted, and hand passwords, MFA, CAPTCHAs, and consequential actions to the user.
Existing Codex approval settings remain in effect.

## Private ChatGPT connection

Chrome's **Connect ChatGPT** button asks the owner to download a separate browser connection. It uses the existing
`IssueBrowserSession` operation, owner login, workspace/runtime binding, Ofz checks and preview revocation. The
downloaded launch ticket expires after 30 seconds; exchanging it creates a browser-only lease lasting at most 30
minutes. This connection does not renew automatically. Closing that Chrome window revokes its exported connection;
sign-out revokes all desktop previews. Downloading a replacement revokes the previous exported connection first.

The browser preview exposes Streamable HTTP MCP at `/mcp`, with the same tool schema, dispatcher and browser actions
as stdio. It requires a fresh `initialize` and returns a random `Mcp-Session-Id`; subsequent POSTs and DELETE require
that ID. Sessions expire after 30 minutes, with a maximum of 16 per guest. The handler rejects browser `Origin`
headers and standalone GET streams. DELETE removes the MCP session and releases its driver. The gateway still
requires its HttpOnly preview cookie on every request, checks fresh Ofz authority, and cancels a pending MCP request
when its preview lease or authority ends. Browser takeover also invalidates input still waiting for cold startup,
even if the user returns control before startup completes.

Use a **dedicated private** [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
for this browser. Do not repoint the existing agents-shell tunnel or publish this connection in a public directory.
Install OpenAI's `tunnel-client` and provide its runtime API key and tunnel ID through `CONTROL_PLANE_API_KEY` and
`CONTROL_PLANE_TUNNEL_ID`. The tunnel's OpenAI workspace and connector access determine who can use this private
connection; restrict them to the intended owner. Creating the tunnel and connecting it in ChatGPT are separate
account actions, not effects of downloading the browser file.

Start the helper before clicking **Download connection**:

```sh
python3 services/nanoagent/browser-mcp-tunnel.py
```

It waits up to five minutes for `~/Downloads/tengri-browser-connection.json` (an optional positional argument selects
another download path). It accepts only a fresh regular file owned by the local user and the exact production
gateway and isolated browser origins. It exchanges the native launch ticket using POST bodies without following
redirects, deletes the consumed connection file, and writes a mode-0600 cookie in a temporary mode-0700 directory.
The OpenAI client injects that cookie only on its private MCP backend hop through `mcp.extra_headers` and
`mcp.discovery_extra_headers`; it is absent from the OpenAI control-plane headers, command arguments and profile.
The helper selects an explicit profile and a small child environment, excluding inherited MCP targets and unsafe
HTTP payload logging. It removes the temporary files when the client stops or the preview lease expires.

Connect ChatGPT's private MCP plugin to that tunnel with no additional backend OAuth flow: the tunnel runtime owns
the already-approved, bounded Tengri browser capability. Keep the helper running, select the actual Pro model and
Pro reasoning mode in a normal Chat conversation, and use `computer`. The same browser remains visible in Tengri.
Have the agent call `release` when its workflow finishes. Human takeover and revocation always remain available.

## Acceptance boundary

`test-vscode-browser.sh` starts the real Nanoagent, Rust preview gateway, and desktop. On Linux, the Chromium suite
uses the native remote display and the production stdio MCP socket. Its test website denies framing and reports
JavaScript form input. The suite verifies manual navigation, text clipboard, agent screenshots and mouse input, native tabs and history, cookies,
local storage, workspace downloads, takeover, grant revocation, and reopening the same browser. It also downloads the
ChatGPT connection through the real desktop UI, exchanges its separate grant through the gateway, and drives the
same Chromium through HTTP MCP, including Unicode form submission, competing-driver rejection, takeover, handback,
release and closing-window revocation. The helper's Python tests verify exact-origin validation, native ticket
exchange, redirect rejection, file permissions and backend-only cookie references.
The disposable gateway shortens preview leases to one minute. Both suites cross the original cookie expiry:
Code retains an unsaved buffer in the same document, and Chrome retains a filled form and human takeover.
Production has no configurable short-lease or authorization bypass.

The guest image independently validates its extracted graphics runtime and 1.5 GiB filesystem. The requested
production rollout still requires the selected Kargo Freight, exact deployed images, an enrolled guest with the browser image,
and actual browser and agent interaction on `proompteng.ai`.
That fixture does not establish ChatGPT Pro compatibility. Live acceptance must separately verify the selected
model/reasoning, completed response's model/reasoning, tool screenshot, navigation, click, type and resulting state
in the Tengri viewer, plus takeover and handback through the connected private tunnel.

Prepared slots retain their boot image and processes across sleep and resume. An image change follows the fenced
recovery procedure in [the operations guide](operations.md); sleep and resume do not upgrade an existing slot.
The prepared-slot release hold remains in effect until its separately authorized cutover is complete.

CI runs the guest fixture in a disposable Docker container. ARC's Talos host disables user namespaces, so the fixture
installs Chromium's root-owned setuid sandbox and gives that container `SYS_ADMIN` for its PID and network namespaces.
Chromium's sandbox remains enabled. The production MicroVM uses user namespaces and does not receive this test
configuration. Browser and editor startup logs are copied out before the fixture container is removed.
