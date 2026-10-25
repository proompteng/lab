# Dedicated Tengri identity realm

The active Keycloak kustomization includes this dedicated realm and its sealed credentials.
It preserves the master realm, Headlamp and Agents Shell clients.

`bootstrap.py` imports only a new, initially disabled realm. It locks managed profile attributes, verifies the GitHub
provider, exact client callbacks, protocol mappers, required actions and authentication flows before enabling it.
Repeat runs verify configuration and fail on drift outside the managed login theme and WebAuthn user-verification
policy. After verification they reconcile those settings and the mounted GitHub and BFF client secrets through the
administrator API, then verify the realm settings and BFF secret readback. They preserve users, passkeys and broker
links. Keycloak replaces the WebAuthn policy as a unit when its RP entity name is present, so reconciliation sends
the current complete policy with only the user-verification requirement changed. The isolated browser fixture
migrates the former PIN-required policy, rotates both secrets after passkey
enrollment, rejects the old BFF secret and completes a fresh login using the rotated GitHub and BFF credentials.

The dedicated `tengri` login theme extends Keycloak's built-in theme. Its shared layout covers passkey setup,
verification and errors with the landing app's Geist font, pear mark, dark wallpaper, window and blue actions.
Assets are served by Keycloak with no external font or image requests. The template retains Keycloak 26.7.4's
session checking, import map and one-click link protection. Its registration module uses Keycloak 26.7.4's
WebAuthn implementation with a unique automatic authenticator label without calling `window.prompt()`, which embedded
browsers reject after creating the credential. Unique labels prevent Keycloak from rejecting a second passkey for
having the same name. The real browser fixture disables prompts, enrolls passkeys, then disables user
verification for subsequent authentication. It verifies that theme and PIN-policy migration preserve existing
credentials while other security drift still fails.
Registration and authentication request `client-device`, `hybrid`, and `security-key` UI hints so browsers offer
password managers such as 1Password, a nearby phone through a QR code, and hardware keys. The hints do not restrict
authenticators or change credential validation. The browser fixture records real WebAuthn requests and verifies
fresh sign-in with both USB and platform passkeys, including their hints and PIN policy.
Verification delegates credential selection to the browser or password manager. Its Continue button becomes disabled
while the passkey request is pending. Stored credential labels and transport details stay out of the page.

Sign in through **Continue with GitHub**, then use your saved passkey. First-time sign-in asks you to create one.
Use **Settings > Access > Add another passkey** to enroll an additional credential.
The BFF requests Keycloak's `webauthn-register` application-initiated action through the existing PKCE flow.
GitHub sign-in and a fresh assertion with an existing passkey precede registration. Then choose 1Password on your
phone, or choose a nearby phone in your computer's passkey dialog and scan its QR code. On iPhone, enable 1Password
under **Settings > General > AutoFill & Passwords** first. Existing passkeys remain enrolled. A user with only a USB
key must verify with that key once before adding the phone credential. This action uses the same origin checks,
OAuth binding, assurance requirements, callback, and ingress rate limit as sign-in.
The browser fixture adds a platform credential to an existing USB-key account and completes a fresh login at a
phone viewport with the USB authenticator removed. A real phone and 1Password provider still require manual proof.
These upstream assets retain their [Apache 2.0 license](theme/LICENSE.txt).
The unchanged wallpaper is attributed in the [landing asset README](../../../../apps/landing/public/tengri/README.md).
Geist retains its [SIL Open Font License](theme/login/resources/fonts/OFL.txt), and the pear retains the
[Pictogrammers notice](theme/login/resources/img/pictogrammers-LICENSE.txt) under Apache 2.0.
The browser fixture checks desktop and 320px setup, verification and error layouts, font loading, reduced motion,
keyboard activation and WCAG A/AA rules. It also covers multiple saved credentials and a pending prompt recovered by
reload. Set `TENGRI_IDENTITY_SCREENSHOTS` to a directory to retain the screenshots.

GitHub's numeric profile ID is copied by its built-in broker mapper into an administrator-only `github_id` attribute.
The username derives from that ID. Email does not link accounts or grant authority. The broker session's provider note
is included in the ID token. The account clients, direct grants, implicit flow and refresh tokens are disabled.
The BFF requires PKCE S256; the realm and client both require authentication level two. The post-broker flow requires
a fresh passkey assertion with physical presence, with passkey enrollment required on first login. WebAuthn user
verification is `discouraged`, so a YubiKey can authenticate with a touch without a PIN check. The key's PIN remains
available for other services. Browser or authenticator policies may still request verification, including during
discoverable-credential enrollment; the realm does not require it.

The existing GitHub OAuth client's ID/secret are sealed into `keycloak-tengri-broker`. Before enabling the BFF,
replace the OAuth app's callbacks with `https://auth.proompteng.ai/realms/tengri/broker/github/endpoint`, and mount
the same confidential BFF client secret in both services. The issuer must have a valid HTTPS certificate.
The hard cutover removes the direct GitHub/Better Auth path; there is no fallback login mode.

The client includes Keycloak's `basic` scope for the signed authentication time and `acr` scope for achieved assurance.
Ofz independently requires both. The configuration was checked against Keycloak 26.7.4 source and tested through its
real administrator API, including repeat verification. The isolated Chromium fixture completed GitHub brokerage,
passkey enrollment, fresh verification, numeric identity separation, admission/assurance denial and Ofz session revocation.
Real custodian enrollment, HA and deployed identity readback remain separate migration gates.
Fixture providers may substitute an isolated GitHub HTTP service;
the production verifier rejects provider endpoint overrides.
