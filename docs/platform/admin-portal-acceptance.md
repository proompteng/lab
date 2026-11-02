# Workspace administration acceptance

## Authority and delivery boundary

The console is the existing Next.js landing application, deployed with `PLATFORM_PORTAL=admin`.
Ofz authenticates its isolated gateway session and authorizes every read and write. No browser state grants authority.
The administration workspace is an Ofz registry entry, **not** a Tengri VM. Names, resource ceilings, service identities,
provider profiles and destinations are reviewed registry configuration (`services/ofz/platform/services.json`).
There is no supported self-service creation/deletion/rename contract for these registry entries. Settings must describe
this boundary, not expose a VM lifecycle operation or invent an editable setting. Supported lifecycle actions are
membership changes, registered-client enrollment, grants, provider consent and request decisions.

## Capability-to-screen matrix

Baseline: `5f16767539fe3f3995467c251710f4401764ab4d`. This matrix records acceptance, not a claim that checks passed.

| Screen       | Authoritative capability / baseline gap                                                   | Acceptance evidence required                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell        | `ListPlatformWorkspaces`, `GetPlatformWorkspace`; three overloaded tabs                   | Sidebar, workspace switcher, breadcrumbs, account navigation; direct links, reload/back/forward, 390/768/1440px, no cross-workspace stale state                                 |
| Overview     | Workspace membership, registered resources and client enrollment; no overview             | Real counts only, clearly labeled admission/enrollment, actionable links to filtered collections, independently loaded request/connection state                                 |
| People       | `WritePolicyRelationships`, admitted GitHub identity resolution; existing basic role form | Search/filter/sort, details, onboarding, update/removal with reasons and consequences; last active administrator protected in UI and Ofz                                        |
| Integrations | Registry client metadata and workspace `client` relationships                             | Discovery/detail, enable/disable with confirmation/reason, exact registered identities, links to resource grants; enrollment must not be described as provider health           |
| Resources    | Registry resources and policy catalog; direct relationship snapshots                      | Catalog/detail, named operations, members/person/client recipients, exact deltas and policy version, reason and fresh MFA; distinguish direct grants from effective access      |
| Connections  | `List/Begin/Complete/DisconnectProviderConnection`                                        | Consent/reconnect/disconnect, revocation warning, explicit confirmation, empty/loading/error states, origin return preserved; consent assigns no grant                          |
| Requests     | Durable create/review/cancel; admin list only pending                                     | Own queue/history, details, reason/decision, bounded history contract, stale decisions and permission loss, same operation after uncertain replies                              |
| Activity     | Audited workspace query, 100-row cursor; no filters                                       | Server-side bounded filtering before pagination, readable actor/action/outcome/resource, inspectable receipt; no claim that one page is all history                             |
| Settings     | Read-only registered metadata plus supported access lifecycle                             | Explain reviewed configuration boundary, IDs in details, links to people/clients/security; no retired product/quota/global-audit editor                                         |
| Security     | Isolated OIDC, Ofz current authority and command journal                                  | Host/cross-workspace denial, last-admin invariant, MFA/session destinations, permission loss mid-form, duplicate-submit prevention and exact uncertain-operation reconciliation |

## Implementation and evidence

The three-tab implementation is removed. The existing mutation components now own separate routed screens, with
server-side initial directory/detail reads, lazy panels, URL-backed collections/details and scoped error/loading
boundaries. All pages use the existing Base UI shadcn family, zinc surfaces and self-hosted Geist. Mobile controls
have 44px touch targets; reduced motion applies to portaled menus as well as the console.

| Requirement                | Implemented proof and remaining boundary                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell and overview         | Chromium route/reload/back/forward, workspace denial and summary tests; all eight pages audited with axe at 390, 768 and 1440px. Server uses authenticated parallel Ofz reads.                                                                                              |
| People and access          | Chromium onboarding, role update, confirmed removal, last-admin UI, validation and collection paging. Ofz's last-active-admin validation remains authoritative; existing real integration coverage is retained.                                                             |
| Integrations and resources | Chromium enroll/disable, resource detail links, ineligible-client denial, mixed-identity grant deltas, exact uncertain replay. Registered identity/destination configuration remains reviewed, not editable.                                                                |
| Provider connections       | Chromium consent return and confirmed disconnect with lost-response reconciliation; twelve BFF provider tests cover binding, callback outcomes and return paths. No stored credential is displayed.                                                                         |
| Requests                   | Chromium pending/review/history, stale decisions and exact replay; BFF validates history/detail/cursor inputs. Ofz integration tests add decided history, equal-timestamp pagination and exact detail lookup. **Real Ofz execution remains gated below.**                   |
| Activity                   | Chromium full-filter-before-page fixture with 205 receipts, cursor reload/back/forward and details. BFF validates exact action/outcome/actor filters. Ofz integration tests check exact filtered receipts. **Real Ofz execution remains gated below.**                      |
| Security and recovery      | Chromium mid-dialog permission loss, session return, forbidden workspace, reload, duplicate-effect counters and saved-operation reconciliation. Mutations retain their exact stored body; comparison parses both payloads to avoid false collisions from JSON key ordering. |
| Settings and exclusions    | Read-only registry configuration boundary and working links to supported lifecycle actions. No VM controls, billing, retired quota/product policy/global audit, credential rotation or direct database/Kubernetes access added.                                             |

### Commands actually run

- `bun install --frozen-lockfile --ignore-scripts` — passed. The first ordinary install failed on the image's missing
  `/usr/bin/env`; no lockfile changes were retained. The existing BusyBox `env` was linked locally to run installed CLIs.
- `PATH=<installed-openssl>/bin:$PATH bun run --filter landing test` — **488 passed**, zero failures.
- `bun run --cwd apps/landing test:admin` — **4 admin BFF, 12 provider BFF and 18 real Chromium tests passed**.
  Browser execution used `FONTCONFIG_FILE=/tmp/admin-fonts.conf` and `LD_LIBRARY_PATH` pointing to isolated downloaded
  browser libraries because the minimal runner lacked them. Chromium 147 was installed by the pinned Playwright 1.59.1
  CLI. The downloaded browser's ELF interpreter was adapted to the image's existing glibc. No repository runtime,
  authentication policy or production deployment was changed for this accommodation.
- `bun run --cwd apps/landing format:check` — passed.
- `bun run --cwd apps/landing lint:oxlint` — passed, zero errors; one existing Tengri warning.
- `bun run --cwd apps/landing lint:oxlint:type` — passed, zero errors; 40 existing warnings outside the changed code.
- `bun node_modules/typescript/bin/tsc --noEmit -p apps/landing/tsconfig.json` — passed.
- `bun run --cwd apps/landing build` — production build passed. A new fixture identity's incorrect email type was
  caught by the build, corrected, and the build rerun successfully.
- `buf lint --path proto/proompteng/authz --path proto/proompteng/relay` and `buf format ... --diff --exit-code` — passed
  using CI-pinned Buf 1.59.0. Generated clients were regenerated with `services/ofz/buf.gen.yaml`.
- Rust 1.90.0 `rustfmt --edition 2024 --check` on the four changed Ofz files — passed using verified official toolchain
  archives with the runner's existing loader. The Cargo/compiler/dependency environment is not available for Ofz tests.
- `python3 services/ofz/tests/inventory.py` and `python3 -m unittest discover -s services/ofz/tests -p 'test_*.py'` — passed,
  **33 Python tests**.
- `bash services/ofz/test-control.sh platform` — **blocked**, exact error: `docker: command not found`; there is also no
  Docker socket or configured remote fixture host. `bash services/ofz/qualify-platform.sh` — **blocked** at
  `uuidgen: command not found`, and also requires the unavailable Docker runtime. Neither is counted as passed.

The landing PR gate now runs `test:admin` explicitly and uploads synthetic browser screenshots, rather than assuming
Tengri's separate Playwright `testDir` includes these tests. Ofz CI remains the mandatory real service qualification.

### Inspected synthetic screenshots

All major pages were captured at 390, 768 and 1440px. Representative retained captures:

- [Desktop overview](admin-portal-screenshots/overview-1440.png)
- [Phone membership](admin-portal-screenshots/people-390.png)
- [Tablet resource grants](admin-portal-screenshots/resources-768.png)
- [Phone approval](admin-portal-screenshots/request-review-phone.png)
- [Activity](admin-portal-screenshots/activity-1440.png)
- [Loading](admin-portal-screenshots/people-loading-390.png), [denied](admin-portal-screenshots/people-denied-390.png),
  [empty filtered collection](admin-portal-screenshots/people-empty-768.png)

These are synthetic fixture identities and resources, not production screenshots. Fixture proof is not live Ofz proof.

## Delivery and live acceptance gate

Implementation and local browser/BFF proof are recorded above. PR/required CI/review/merge and release evidence are
not yet established by this document. Do not treat this as a completed rollout certificate.

Normal delivery must remain the coordinated Ofz → web immutable image publication, Kargo promotion and Argo
reconciliation path. Record the merged commit, immutable image digest, Kargo promotion commit and deployed revision
at delivery. No production grants, memberships, provider connections, identities or credential permissions were
changed during development. Live authenticated portal acceptance requires an authorized session and any human
passkey step-up; Pod health alone cannot satisfy it. If that identity is unavailable, report the exact outstanding
live acceptance rather than manufacturing a login or mutating real accounts.
