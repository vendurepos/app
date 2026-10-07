# Register contract version 2 in the Vendure plugin: device identity, resume, take-over, unknown sessions

Status: Proposed (one-way: a migration and a plugin API change; merges on Paul's word)
Date: 2026-10-06

## Context

TallyUI ADR-078 gives a register session a device and adds three store-side rules:

- **Resume.** A till that lost its local state may resume its own live session.
- **Take-over.** Another till may take over a live session.
- **Unknown sessions.** An order naming a session the store does not hold is still applied.

Step 1 of that ADR is the contract types in TallyUI/tallyui#469 (`packages/core/src` at `2894a59`). The till half is TallyUI's steps 2–4; this app picks it up with a later `@tallyui/*` bump. medusapos implements the same store side in medusapos/app#236. The plan is vendurepos/app#167.

The store side, as ADR-078 states it:

- **d1:** `/info` advertises `register: [1, 2]`. A v2 `register.session.open` carries `deviceName` and `supersedes`, and the envelope's `deviceId` is recorded.
- **d2:** a v2 open from the device that holds the register's live session resumes it. The open's `sessionId` becomes a permanent alias.
- **d3:** a take-over is a compare-and-set. `supersedes` must name the live session, or the open is refused `register_session_already_open` with the live session's details.
- **d4:** every later command naming a superseded session is refused `register_session_superseded`, or `register_session_closed` at contract 1.
- **d7:** an `order.create` naming an unknown session is applied with the warning `register_session_unknown`.

The Vendure plugin already has these pieces in place (ADR 0003):

- every register command runs under a per-register advisory lock (§2);
- register tables are write-once, with no `UPDATE` or `DELETE` (§3);
- core's types are vendored rather than depended on (§6).

## Decision

### 1. Versions

`REGISTER_VERSIONS` is `[1, 2]`, so `/tally/v1/info` lists `"register": [1, 2]`.

A version 1 command gets the same result as before, with one exception: a v1 command naming a superseded session is refused `register_session_closed` (§5).

The strict shape (ADR 0003 §4) allows `deviceName` and `supersedes` on `register.session.open` from version 2 only.

### 2. Device identity

Every open, at any version, records the envelope's `deviceId` on the session. A v2 open also records `deviceName`, trimmed.

Every open also records its version as `openVersion` (migration `TallyPosRegisterOpenVersion1791100000000`).

The migration `TallyPosRegisterV21791000000000` adds three nullable columns to `tally_register_session`: `deviceId`, `deviceName` and `supersedes`.

### 3. Resume (d2)

A v2 open is checked for a resume first, under the register's lock.

**When it applies:** the register's live session was opened by the same `deviceId`.

**What it does:** the open is applied without opening anything.

- `register.session` is the live session, plus `openedAt` and `openingFloatMinor` (its counted float).
- When the open's `sessionId` is not the live session's own id:
  - the result carries `resumed: { fromSessionId }`;
  - that id is written to the new write-once table `tally_register_session_alias`, keyed `(channelId, id)` and pointing at the live session.

**Refused:** an open whose `sessionId` is already a different session, or an alias of one, is refused `invalid_payload` (unstored), as a duplicate session id always was.

### 4. Take-over (d3): compare-and-set under the lock

A v2 open with `supersedes` takes the register over only when `supersedes` names the live session, directly or through an alias.

**The open writes, in one transaction:**

- a `tally_register_session_status` row `superseded` on the old session, with `at` set to the new open's `openedAt`;
- the new session, whose `supersedes` column names the old one.

The result carries `superseded: { sessionId, openedAt, deviceId?, deviceName? }`.

**Refused:** when `supersedes` names anything else (an older session, a superseded one, a stranger), the open is refused `register_session_already_open`. At v2, the refusal's `data` is the live session's: `sessionId`, `registerId`, `openedAt`, `status`, and `openedBy`, `deviceId` and `deviceName` when known. At v1, the `data` is `{ sessionId }` as before.

**Nothing live:** an open is a plain open whatever its `supersedes` says.

**Concurrency:**

- The advisory lock serialises two racing take-overs: the second sees the first's new session as live and is refused naming it.
- A unique constraint on `(channelId, supersedes)` is the database backstop: a session is taken over at most once.

**Not emitted:** `register_supersede_forbidden` stays reserved. Anyone allowed to open may take over.

**Liveness:** `openSessionOf` treats a session as live unless its last status is `closed` or `superseded`, or it has a closure. A superseded session is never live again.

### 5. Later commands (d4)

**Aliases resolve.** Transition, movement record and void, and closure submit all resolve `payload.sessionId` through the alias table. Everything after the lookup uses the resolved session: the lock, the rows written, and the result. The stored command keeps the id the till sent.

**Superseded sessions are refused.** On a superseded session, these commands are refused:

- when the command or the session's own open is version ≥ 2: `register_session_superseded`, with `RegisterSessionSupersededData` (front desk ruling 2026-10-07, TallyUI/tallyui#515);
- when the command is version 1 and the session's open version is 1 or unknown (`null`): `register_session_closed`, with no data.

Like every `register_*` conflict (ADR-068 d5), the refusal is stored.

**The refusal's data is derived, never stored twice:**

- `sessionId`: the resolved id;
- `supersededAt`: the status row's `at`;
- `newSessionId`, `supersededBy`, `deviceId` and `deviceName`: read from the session whose `supersedes` names it.

### 6. Figures

The live figures (`expected`, `salesCount`) count orders whose `tallySessionId` is the session or any of its aliases. That way a resumed till's sales under its old id still count. Closure figures are unchanged: they count the closure's own `orderIds` and `movementIds` (ADR 0003 §5).

### 7. Unknown sessions (d7)

When an `order.create` at version ≥ 3 names a `sessionId` that is neither a session nor an alias in the channel:

- it is applied exactly as before;
- its result gains a last warning, `{ code: 'register_session_unknown', sessionId }`.

The check reads without the register lock: the warning means "not known when applied". It is stored with the result, so a replay answers the same.

The order keeps its `tallySessionId`. A session opened later under that id, or an alias written later, counts the order.

The only gate is the field itself: `sessionId` exists from `order.create` version 3, and an order without one gets no warning. No newer version is needed for the warning, because the till's reader of warnings (`knownWarnings` in `@tallyui/core`, 3.5.1 and later) skips codes it does not know. The plugin's own strict `parseCommandResult` (vendored) learns the code in §8.

### 8. Vendored hunks

TallyUI#469's changes are applied to the vendored files, and each file's provenance header notes them:

- `src/vendored/core-commands.ts`: the session fields, `resumed`, `superseded`, the two data interfaces, and the warning;
- `command-result.ts`: the warning parser;
- `register-outcome.ts`: the two refusal codes;
- `register-payload-shape.ts`: the open's v2 fields.

The plugin stays off `@tallyui/core` (ADR 0003 §6).

## Consequences

- **The migration is one-way in practice.**
  - Its `down` drops the alias table, the three columns and the unique constraint. But the `superseded` status rows stay, and status is a plain `varchar`.
  - After any take-over or resume, `down` leaves data the older code misreads:
    - an old session whose last status is `superseded` looks live again to the v1 `openSessionOf`;
    - a resumed till's sales under its alias stop counting.
  - Run `down` only on a store that never served a version 2 open.
- **No register read endpoint.** This plugin has none, so d7's "the register read lists abandoned orders" has nothing to extend. An order on an unknown session counts on no session until one is opened or aliased under its id.
- **A superseded session takes no further command.** Its movements and orders stay recorded under it, and no figure moves them to the new session. The till that took over counts from its own float.
- **Install:** run the bundled migration `TallyPosRegisterV21791000000000`, or generate your own, before a till sends register version 2.
