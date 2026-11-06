# Effective entry allowance input: v38 to v39

## Release boundary

This is a draft executable protocol successor. Do not merge it into automatic delivery until the separate native
deactivation and protocol-bound PAPER reactivation changes have been reviewed and ordered. The draft changes no
GitOps activation manifest, SealedSecret, credential, capital mandate, account, or running authority. A refusing
migration is a fail-closed protection, not a deployment plan or approval to interrupt PAPER service.

The defect is conflicting retained input metadata. v38 already caps entries at the original inference ask rounded
upward to the broker tick, applying zero quote drift and zero limit slippage. Its numerical entry economics still
reported the shared raw protocol values, 10 bps each. The entire input is hashed into request, evaluation and batch
identities. Editing v38 output or rewriting retained rows would invalidate that evidence.

v39 changes only those two reported values to the effective 0/0. Protocol v39 supplies the semantic version;
numerical state v24, inference input v8, batch v8, question policy, provider and model remain unchanged. The raw
protocol fields stay 10/10 because liquidation and proposal stop economics use them. Entry price limits, tick
rounding, fees, sizing, exit economics, 0.70/0.30 judgments, 20% allocation, one position, 15-minute holding,
ten-second inference validity, universe and equity-entry/retained-crypto-exit scope remain unchanged.

## Immutable identity

| Field                                      | Retained v38                                                       | Successor v39                                                      |
| ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `strategy.parameterSchemaVersion`          | `bayn.jev.protocol.v38`                                            | `bayn.jev.protocol.v39`                                            |
| `strategy.parameterHash`                   | `fa21a9d606eed0332637937d4d46035ba649d3fef968ab39480af796f13f419b` | `a03aad6fdf2c2f9d958f5922e69da57fbd2b6e3575941840076b20cebd5a0c54` |
| `strategy.protocolHash`                    | `489e704106e73592eb03dd8daf0750cbbb157e4d257bf53b948da1449b0c2d3c` | `769bf588ec2944657b235e12c8c43a431339eab51ee4159cd44909ceaa9fed34` |
| `strategy.behaviorHash`                    | `76f0e134e622ada19cb1b087d83da60b54a36d33c86c6c0eee2642ee3fbd3e67` | unchanged                                                          |
| `numericalState.entryEconomics` allowances | 10/10 in retained bytes                                            | 0/0 in new bytes                                                   |
| Effective entry allowances                 | 0/0                                                                | 0/0                                                                |
| Raw shared protocol allowances             | 10/10                                                              | 10/10                                                              |

The checked-in mandate annotation currently identifies request
`588976a7a41ea2b4d64d65597411634e0517cf31869c9051205c739add4c57ed`, with authored source
`42e4e27f0ffaf59d92ebd8f5d41b114fb961e78e` and authored image
`sha256:3854b5f41d520ad775a3e0f7f506d4220387ce69ed708a6f44da2a1e6fbcb81a`.
This annotation is in `argocd/applications/bayn/alpaca-sealedsecret.yaml`; it records identity, not permission to
change the encrypted request. No encrypted or plaintext secret is copied into this document.

The draft also updates `nix/images/bayn.nix`'s compiled parameter/protocol constants and OCI labels to v39.
These identify the successor image; `verify-build-contract` must verify them against the executable. They do not
update any deployed manifest or activation request. Keeping v38 build metadata on v39 source correctly fails the
image build, so that mismatch is not used as a release gate. The draft hold and reviewed authority ordering remain
mandatory even when the source image builds successfully.

The existing Kargo contract tests require the sealed mandate and runtime manifests to agree with that compiled
image identity. They intentionally remain unchanged and reject this source-only draft's v39/v38 mismatch until
the reviewed deactivation and coordinated binding changes below are ready. A passing image build does not make
those delivery checks optional; neither their expectations nor the deployed bindings are rewritten in this draft.

`capitalActivationRequestIdentityIsCurrent` compares the exact protocol hash, parameter hash, schema version,
strategy name and behavior hash. `researchCapitalRecoveryRequestIsCompatible` enforces the same identity before
durable recovery. A v38 mandate or build-lineage continuation cannot authorize v39. The Research grant class,
sandbox account, broker identity, risk policy and monetary limits can stay the same, but `grant.planHash` and the
request hash necessarily change because the plan binds the new strategy identity. Historical balances, loss and
turnover records are retained; this correction provides no permission to widen their ceilings.

## Required reviewed ordering

1. Keep this successor draft out of main while the v38 PAPER binding is active. Prepare the normal reviewed GitOps
   native deactivation on a v38-compatible source. Remove the old activation request, kind and research lineage
   inputs through the established OBSERVE-only path. The native controller must settle its work and record OBSERVE;
   a manifest edit alone is not proof of settlement. Preserve credentials and existing account ownership.
2. Verify terminal cycles/intents, no live broker orders, flat broker and ledger inventory, complete accounting,
   zero unresolved mutations, fresh EXACT reconciliation after settlement, and no unexpired unresolved inference
   request. Existing crypto positions retain their normal v38 exit/recovery path until flat. Do not force the
   migration past a held position, an operator hold or stale reconciliation.
3. After that boundary, merge the reviewed v39 source with its corresponding source identity bindings. In
   `deployment.yaml`, `execution-controller.yaml` and `execution-activation.yaml`, update
   `BAYN_STRATEGY_PARAMETER_HASH`; update `BAYN_STRATEGY_PROTOCOL_HASH` wherever configured. Keep the activation
   request/kind/lineage absent while v39 starts in OBSERVE. Let main → immutable image → Kargo → Argo deliver the
   image and source bindings. Do not set an image digest or invoke activation manually.
4. Migration 183 refuses non-OBSERVE authority and repeats the terminal/flat/settled/accounting/reconciliation/claim
   checks under advisory and table locks. It changes only protocol admission constraints and functions. It retains
   v38 rows and permits their existing terminal receipts, while new requests and dispatch require v39. New
   economics must be null for an unfunded candidate or carry numeric 0/0. Mixed versions, 10-bp metadata, string
   zeros and missing fields fail closed. The migration never updates authority or financial evidence.
5. Verify the published immutable v39 image, its compiled identity, successful migration and native OBSERVE
   readiness. Prepare a reviewed same-account `ResearchCapitalActivationRequest` bound to that exact image/source
   and v39 identity. Preserve broker account/environment/identity, Research grant class, risk policy, limits,
   credentials and all financial history. Recompute the plan/request hashes through existing constructors.
6. Restore the sealed `capital-activation-request` and its matching `proompteng.ai/bayn.mandate-identity` annotation,
   `BAYN_CAPITAL_ACTIVATION_REQUEST`, `BAYN_CAPITAL_ACTIVATION_KIND=ResearchCapitalActivationRequest`, and
   `BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE` in all three runtime manifests as one reviewed change. The lineage must
   bind the new request and verified authored build. Use the existing activation-generation/Kargo mechanism.
   Argo's established order remains Secret wave -2, controller wave -1, activation hook wave 0, status wave 1.
7. Require natural controller progress, exact reconciliation, zero unresolved mutations, the intended PAPER
   authority, and retained new requests showing protocol v39 and effective 0/0. Compare actual entry limits to
   original inference caps and preserve existing exits and accounting. Input consistency alone does not prove
   improved profitability.

The source-only draft deliberately leaves step 3's GitOps identity update and steps 1/6's activation changes for
that coordinated review. Replacing only the Secret, editing an annotation, extending v38 build lineage, suppressing
the migration guard, or directly calling the activation handler is not a valid cutover. Follow the existing native
deactivation/mandate-rotation rollback procedure if activation has occurred.

## Regression evidence

Before editing source, main `8f87974758c4490bbfc9549fc7c44ba5f02f871a` generated golden identities for all 30 candidate
requests across one complete native batch and one ablation batch. The fixture pins each canonical request hash,
request ID, byte length, observation hash, protocol hash, question-set hash and batch ID. The retained-v38 readers
reconstruct those exact bytes and reject rehashed source substitution. Current execution remains v39-only.

Tests compare every other economics field across v38/v39 for equity and crypto, including off-tick asks and crypto
fee tiers; they also verify unchanged raw 10-bp settings, rejection of unknown/mixed protocols, and refusal of the
v38 mandate by both fresh activation and recovery. Existing historical protocol/cost tests remain part of the
service suite. The existing PostgreSQL integration shard exercises pre183→183 migration with retained v38 requests
and claims, completion of their original terminal receipt, current-v39 insertion, malformed-input rejection and
refusal while cycles or PAPER authority remain active. CI supplies the isolated real PostgreSQL proof.

### Retained readers and current admission

The retained helpers are wired to existing read-only consumers, not just exported for tests:

| Consumer                                         | Retained v38 behavior                                                                                                                                                                         | Admission boundary                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Staged inference cost evidence                   | Reconstructs original request, provider checkpoint, receipt and resolution identities                                                                                                         | Fresh requests remain current-only                                             |
| Study export and signal study                    | Replays native and ablation request/batch/result evidence and original candidate selection                                                                                                    | No executable retained target is admitted                                      |
| Stored operational registrations and assessments | Preserves the original v38 strategy binding and prior assessment hashes                                                                                                                       | New registrations require v39                                                  |
| Operational source replay                        | Explicitly verifies original native, ablation and repeated-momentum v38 entry/exit identities and flat documents through the shared risk, planner, quote, authority and canonical hash checks | Current execution decoder and constructor stay v39-only                        |
| Forward-performance decision projection          | Uses that same retained document verifier for the original candidate and control trading evidence                                                                                             | Older unsupported versions and unknown identities remain explicitly unverified |

Independent original candidate, ablation and repeated-momentum entry and protective-stop documents pin exact
canonical bytes, document content hashes and target material. Original Bun/Nix Node crypto documents also prove
native fractional quantity and asset-profile reconstruction. Tests reject outer-rehashed planner/risk/authority
tampering, recognized-policy relabeling, mixed or unknown protocol versions, and v38 documents bound to a current
operational registration. Public readers retain old control context without attributing it to candidate work.
A separate work-binding regression matches account, generation, risk and reporting interval while varying only
strategy policy: control evidence earns no candidate completion, and the same-policy control demonstrates that
the original work is otherwise creditable. Synthetic fixture generations are never rebound to a fabricated
capital mandate. Current v39 entry and exit construction for all three policies is exercised separately with
unchanged raw liquidation allowances.

The original chart identity already includes PNG compression bytes. Bun 1.4.3, production Nix Node 24.11.1 with
shared zlib 1.3.1, and the official Node 24.11.1 build with bundled zlib 1.3.1-470d3a2 produce different `IDAT`
bytes for identical pixels. The original v38 decoder independently demonstrates the same build-dependent
rejection; Node's version number alone is not a compatibility proof. Immutable fixtures and full capture/parity
provenance preserve that boundary.

The bounded `test:production-runtime` regression is mandatory in both Nix image builds using their actual
production Node. It verifies all seven original production-compatible candidate/control/crypto documents,
current rejection and public profitability projection. Unit tests retain the Bun evidence. The script
remains type-checked and formatted; its temporary bundle and fixtures are not installed into the image. Existing
operator commands use compiled Node bundles. No runtime skip, alternate hash, launcher or renderer change is
introduced.

Migration number 0183 was rechecked against main `fbaf67ff61354c2625851510f870e75ab248ffc6`, whose latest migration
is 0182. Renumber and repeat the migration proof if another migration lands before this deferred cutover.
