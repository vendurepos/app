# The register commands: TallyUI's five `register.*` commands (contract v1) in the Vendure plugin

Status: Accepted (2026-09-30, on the dispatcher's rulings for the register job)
Date: 2026-09-30

## Context

TallyUI's registers sync to the server as five commands on the same
`POST /tally/v1/commands` route as `order.create` (TallyUI ADR-068):
`register.session.open`, `register.session.transition`,
`register.movement.record`, `register.movement.void` and
`register.closure.submit`, each at version 1. A till sends them only when
`/tally/v1/info` lists `"register": [1]`. The contract is TallyUI's
`docs/contract/field-kinds.md` (the register tables, the declared maps,
"Malformed commands") and ADR-068's "Every plugin's checklist", read at
TallyUI `09ea612` with `@tallyui/core@3.0.0-next.1`.

Three things the contract leaves to a plugin, or that core does not do yet:

- **Unknown fields and map keys.** ADR-070 decision 1 refuses both, but
  core's `registerPayloadErrors` accepts unknown keys (TallyUI #255) and
  any key in `counted` and `tillExpected` (#256).
- **Concurrency.** The contract rules "at most one non-closed session per
  register" and a closure number of the register's last plus one, with
  two tills on one drawer as the case it exists for, but gives no locking
  recipe.
- **A closure naming another register.** ADR-068 decision 6a says
  `invalid_payload`; decision 5 lists it with the unstored,
  state-dependent refusals.

## Decision

### 1. One pipeline for every register command

`RegisterService.apply` runs each command in its own transaction, in
`order.create`'s step order (ADR 0002 §2):

1. **Shape**, before any database access: a string holding U+0000, then
   the version (`unsupported_version` with core's message and
   `data: { register: 1 }`), then core's `registerPayloadErrors`.
2. **The replay read.** A committed id answers as recorded: `duplicate`
   with the result recorded at apply (never the current state), or
   `rejected` for a stored refusal. Another channel's id, or another
   payload's fingerprint, is `idempotency_mismatch`.
3. **Strict fields and map keys** (§4), then the **client-time stage**:
   the envelope's `createdAt`, then the payload's time fields in
   field-kinds.md table order (`openedAt`; `at`; `createdAt`;
   `openedAt`, `closedAt`), with the same messages, bounds, clock and cap
   of 10 as `order.create` (`clientTimeErrors`).
4. **The session** (every type but `session.open`). Sessions are
   write-once and never deleted, so this read needs no lock: an unknown
   session is `invalid_payload` (`sessionId: unknown session <id>`), and
   a closure whose `registerId` is not its session's is `invalid_payload`
   (`registerId: expected the session's register <id>`). Both are
   unstored, so a resend re-evaluates (ADR-068 d5).
5. **The claim**, `order.create`'s ledger row with the same 5 s wait
   (409 `in_progress`) and fingerprint; a register command's row has no
   `clientOrderId`.
6. **The register's lock** (§2).
7. **The state checks**, the writes, and the stored result.

Every result passes core's `parseCommandResult`. `applied` carries
`register` and no `serverRefs`: `session` (`id`, `status`, `expected`,
`salesCount`) for the session and movement commands, and `closure`
(`serverClosureId`, the till's `closureId`; `number`; `expected`;
`variance`) plus `counters` for `closure.submit`.

The refusals:

| Refusal | Code | Stored |
|---|---|---|
| a second non-closed session on a register | `register_session_already_open`, `data: { sessionId }` of the winner | yes |
| a transition out of closed; a movement or void on a closed session, or one whose closure is submitted | `register_session_closed` | yes |
| a second closure for a session (or a reused `closureId`) | `register_closure_exists`, `data: { closureId }` | yes |
| `number` ≠ last + 1 | `register_closure_number_invalid`, `data: { counters }` | yes |
| an unknown session; a closure on another register | `invalid_payload` | no |
| a void target missing from the void's session (or itself a void); a target already voided | `invalid_payload` | no |
| a `sessionId` or `movementId` already recorded by another command | `invalid_payload` | no |

A stored refusal replays as `rejected` with the same code and message.
An unstored one after the claim rolls the claim back. A void of a void, a
second void of one target and a reused id go beyond the contract's list:
none has a `register_*` code and no correct till sends one, so they are
refused like a missing target rather than stored under a code the till
does not expect.

The transition is a state snapshot (ADR-068 d5a): the last applied one
sets the status, the same status is an applied no-op that writes nothing,
nothing leaves `closed`, and intermediate states may be missing.
Movements and voids are accepted on an open or counting session. Nothing
compares `at`: commands apply in the order received, a batch in array
order.

### 2. A per-register advisory lock

Every register command's transaction takes
`pg_advisory_xact_lock(0x7a13, hashtext(<channel, register>))`, where the
second key is the JSON array `[channelId, registerId]`, after its claim
and before any state read that decides it. A command that carries only a
`sessionId` reads the session first (step 4); its register never changes.
The namespace 0x7a13 is apart from `StoreSetupService`'s 0x7a11 and the
customer lock's 0x7a12. A wait past the 10 s `lock_timeout` is a 503, as
every wait after `order.create`'s claim is.

The lock serialises a register's commands across tills and Vendure
instances, so "at most one non-closed session" and the closure-number
sequence hold under two tills. The unique constraints below are a belt:
a race the lock missed would be a transient 503, never a second closure.

### 3. Write-once tables

Five tables, every row keyed by the channel the command ran in
(`channelId`, as the ledger's) and by its id, so ids are unique per
channel; rows are only ever inserted:

- `tally_register`: the drawer, created by the first
  `register.session.open` naming it (ADR-068 d8).
- `tally_register_session`: the till's open fields and its `registerId`.
- `tally_register_session_status`: one row per applied status change,
  with `at`, `counted`, `closedBy` and `approvedBy`; a serial `seq` gives
  the applied order, and the last row's status is the session's (`open`
  before any).
- `tally_register_movement`: movements and voids; a void is a row of type
  `void` naming its target in `voids`, unique per channel.
- `tally_register_closure`: every instruction-recorded field, `orderIds`
  and `movementIds`, the till's `tillExpected` and `counted` as the
  fiscal record, and the server's `expected` and `variance`; unique per
  session, and per register and number.

The till's times are kept as the strings it sent, and minor units in
`bigint` columns. `lastClosureNumber` and the perpetual totals are never
stored: they are derived from the register's closures under its lock (the
highest `number`, and that closure's `perpetualSalesTotalMinor`).
`perpetualRefundsTotalMinor` is 0 until refunds exist (ADR-068 d9).

Migration `TallyPosRegister1790800000000` creates the tables and makes
the ledger's `clientOrderId` nullable.

### 4. Strict fields and map keys, in the plugin

`registerStrictErrors` (`strict-shape.ts`) refuses a field no version 1
payload of the command's type declares, at the envelope and payload
level (`<path>: unknown field in <type> version 1`), and a key of
`counted` or `tillExpected` other than `cash` or `external`
(`counted.card: unknown key in <type> version 1`), both naming the full
path from the payload (ADR-070 d1). It goes when core's checks land
(TallyUI #255, #256).

### 5. Figures

The vendored `deriveSessionFigures` and `deriveVariance` compute them,
from each order's `tallyPayments` (the payload's payments as
`order.create` recorded them, `amountMinor` net of change) and the
session's movement rows.

- **Live** (every session result): the float, plus every order in the
  channel whose `tallySessionId` is the session, plus the session's
  movements, voids applied (ADR-068 d13.1). `tallySessionId` already has
  its index (`IDX_tally_order_session_id`).
- **At the closure**: the float, plus the orders in `orderIds` found in
  the channel by `tallyClientOrderId`, plus the movements in
  `movementIds`, with every void row of the session applied (d13.2).
- **Received** means `order.create` finished the sale: `tallyPayments`
  is set, which the recipe writes at its end, so a partial sale awaiting
  an admin is not counted. A `tallyRejected` order never counts
  (d13.6 amendment).
- `order.create.sessionId` stays a soft reference, never refused.

### 6. Vendored from `@tallyui/core@3.0.0-next.1`, not a dependency

`@tallyui/core` has a required `react` peer, which would land in every
store that installs the plugin. So its server files are vendored into
`src/vendored/`, verbatim, each with a first-line provenance comment:

- `src/server/register-payload-shape.ts`, `register-figures.ts`,
  `register-outcome.ts` and `command-result.ts`;
- `src/types/commands.ts`, as `core-commands.ts`: the relative import of
  the two files that import `../types` (whose index pulls in rxdb), and
  the one outside `src/server/`. The existing `commands.ts` keeps its
  older vendored copy, unchanged.

The only changes: `register-outcome.ts` and `command-result.ts` import
`./core-commands` where the originals import `../types`. The existing
vendored files are untouched; the register commands' fingerprint uses
the existing `fingerprint.ts`, whose algorithm is core's.

## Consequences

- `/tally/v1/info` lists `"register": [1]` from `REGISTER_VERSIONS`, the
  list the version gate reads. A batch may mix `order.create` and
  `register.*` commands, applied in array order with one clock read per
  request; `order.create` is unchanged.
- **Not built:** c2b's anchoring (the till adopting `expected` and the
  counters), c2c's approval (`approverToken`,
  `register_approval_required`, a server variance threshold; `approvedBy`
  is recorded as sent) and `GET /tally/v1/registers/{id}`. Refunds stay
  out of every figure.
- The strict checks and the vendored copies go when core's
  `registerPayloadErrors` checks fields and keys (TallyUI #255, #256);
  re-vendoring replaces the vendored files whole.
