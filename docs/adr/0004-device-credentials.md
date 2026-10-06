# Device credentials: how a till authenticates to the store

Status: Accepted (front desk ruling, 2026-10-06, as proposed, with the three additions under "Decision")
Date: 2026-10-06

## Context

**Today a till is a person's session.**
- A cashier signs in with a Vendure administrator's email and password (`apps/pos/lib/sign-in.ts`). The till keeps that administrator's session token: `tokenMethod: 'bearer'`, held in the browser's storage as medusapos ADR 0002 does (`apps/pos/lib/session.ts`).
- Every request carries `Authorization: Bearer <token>`, built by TallyUI's `vendureAuth.getHeaders` from `connector-vendure`, plus `vendure-token` for the channel.

**What follows from that:**
- the till is as powerful as that administrator's roles;
- it lives as long as Vendure's session (default `sessionDuration` one year);
- revoking it means ending the session, or changing the password, which affects every till that person signed in;
- the store can't tell tills apart.

PLAN M6 lists "a `TallyPosSell` custom permission, a Dashboard extension to register devices, and API keys as device credentials". `TallyPosSell` landed first (ruling (e), #137). This ADR is about the rest.

**What Vendure gives us (read in `@vendure/core` 3.7.3).** Vendure has native API keys **since 3.6.0**, the floor the plugin already requires (`compatibility: '^3.6.0'`):
- an `ApiKey` entity: channel-aware and soft-deletable, holding only a hash of the key (`apiKeyHash`, `lookupId`), with `lastUsedAt`, a translatable `name`, an `owner` (the creator) and a `user` whose roles authorize it;
- Admin API operations: `createApiKey(input: { roleIds, translations })`, which returns the key **once**; `rotateApiKey(id)`; `deleteApiKeys(ids)`; `apiKeys(options)`; and `apiKey(id)`. A creator "may only grant roles which you, yourself have";
- auth configuration: `authOptions.tokenMethod` may include `'api-key'` (since 3.6.0). The key travels in the `vendure-api-key` header (`apiKeyHeaderKey`). `authOptions.adminApiKeyStrategy` / `shopApiKeyStrategy` decide how keys are generated and checked (`@since 3.6.0`).

## Question 1: Vendure's API keys, and how stable they are per minor version

**Options**
1. **Build on Vendure's native `ApiKey` (3.6+).**
   - **Pros:** no plugin entity or hashing of our own; rotation, revocation, channel scope and `lastUsedAt` come with it; the Dashboard can list keys.
   - **Cons:** the feature is recent (3.6.0). Its strategy interfaces carry `@since 3.6.0` and could still change in a minor release. Merchants must add `'api-key'` to `tokenMethod`, another config step after `'bearer'`.
2. **Our own device entity and token in the plugin** (a `TallyDevice` table with a hashed secret, checked by our own guard on `/tally/v1`).
   - **Pros:** fully ours and stable.
   - **Cons:**
     - more code and security surface: hashing, timing-safe compare, rotation;
     - it covers only our routes. The till also calls the **Admin API** (catalogue, settings, customers), which would still need a Vendure credential, so this doesn't remove the person's session.
3. **Keep bearer sessions**, and add only device naming and a revocation list on top.
   - **Pros:** least change.
   - **Cons:** the core problem remains: tills are people's sessions.

**Recommendation: option 1.** The till needs one credential that works for both the Admin API and our routes, and only Vendure's own keys do that.
- Pin the risk with a plugin e2e test that creates, uses, rotates and deletes a key on the supported Vendure range.
- Re-run it on every Vendure minor in the dev store's upgrade PR.

## Question 2: enrolment, by QR code or by a pasted key

**Options**
1. **A pasted key.**
   - **How:** an admin creates a key in the Dashboard (or our extension), copies it, and pastes it into the till's sign-in screen ("Sign in with a device key").
   - **Pros:** simplest; no camera, so it works on any till.
   - **Cons:** typing or pasting a long secret on a till; the key shows on the admin's screen.
2. **A QR code.**
   - **How:** our Dashboard extension shows a QR code carrying `{ storeUrl, channelToken, apiKey }`, and the till scans it with its camera.
   - **Pros:** fast, and no typing.
   - **Cons:**
     - camera permission;
     - many web tills (desktops) have no camera, so pasting is needed as a fallback anyway;
     - the QR is a secret on screen.
3. **A one-time enrolment code.**
   - **How:** the Dashboard shows a short code, valid for ten minutes. The till exchanges code plus store URL with a plugin endpoint for an API key, which then never shows on any screen.
   - **Pros:** no long secret shown or typed; works without a camera.
   - **Cons:** a plugin endpoint that mints keys (privileged), with expiry and rate limiting to build.

**Recommendation: 1 first, then 3.**
- **First:** a pasted key, behind a "Sign in with a device key" option next to today's email and password. It needs no new server code beyond the Dashboard extension's "create device" button.
- **Later:** the one-time enrolment code (3), as the polished path. A QR code (2) can carry that short code later, never the key itself.

## Question 3: rotation and revocation

**Options**
1. **Vendure's own operations, surfaced in our Dashboard extension.**
   - **How:** "Revoke" calls `deleteApiKeys`; "Rotate" calls `rotateApiKey` and shows the new key once.
   - **What the till sees:** a 401, then our existing "Sign in again" panel (#131), extended to take a new device key.
2. **Automatic rotation:** the till rotates its own key on a schedule.
   - **Cons:** rotation needs `UpdateApiKey`-like rights on the till; a till offline across a rotation can be stranded; more moving parts.
3. **Revocation only**, with no rotation UI. Rotate by revoking and enrolling again.

**Recommendation: option 1, manual only.** Revocation is the important control (a lost or stolen till), and rotation is a convenience. `lastUsedAt` shows the admin which tills are alive. No automatic rotation in v1.

## Question 4: is a device an Administrator, or a new entity?

**Options**
1. **A device is an API key owned by the enrolling administrator, with a dedicated role** (for example "POS till": `TallyPosSell` plus the catalogue and settings reads it needs, in the store's channels).
   - **Pros:** no new entity; Vendure's own model; the key's `name` is the device name; `lastUsedAt` and revocation are built in.
   - **Cons:**
     - each key still runs as a `User` (Vendure's model), so the store's audit trail shows that user. We should check in the plugin e2e test whether the ApiKey user is the owner or a dedicated user, and what the order history records;
     - Vendure allows granting only roles the creator holds.
2. **A dedicated Administrator per device** ("Till 1", with its own email), signed in by bearer as today.
   - **Pros:** works on any Vendure 3.x with today's code; per-device audit.
   - **Cons:** fake administrator accounts; passwords to manage; the same long-lived session problem.
3. **A plugin `TallyDevice` entity mapped to an API key**, holding the device name, register binding and enrolment metadata.
   - **Pros:** room for POS-specific fields (default register, location).
   - **Cons:** a migration and a second source of truth beside `ApiKey`.

**Recommendation: option 1 for v1.** Devices are Vendure API keys with a "POS till" role. Add 3 only if a POS-specific field becomes necessary; until then, the key's name and custom fields (`ApiKey` has `customFields`) are enough.

## Decision

Build device credentials on **Vendure's native API keys (3.6+)**:
- **The role:** the plugin ships a "POS till" role preset: `TallyPosSell` plus the reads the till needs. A merchant applies it from our Dashboard extension.
- **The extension:** create a device (a named API key with that role, shown once), list devices (name and `lastUsedAt`), and rotate or revoke them.
- **The till:** gains "Sign in with a device key" (a pasted key) and sends `vendure-api-key` instead of a bearer token. A refused key shows the existing "Sign in again" panel.
- **Merchant setup:** the quick-start adds `'api-key'` to `tokenMethod`.
- **Later:** one-time enrolment codes.

**Additions on acceptance (front desk, 2026-10-06):**
1. **The key is a secret everywhere it appears.** The till's "Sign in with a device key" field is masked, like a password. The Dashboard extension shows a new key exactly once, at creation or rotation, and never again.
2. **The open point in Question 4 is settled by test before the Dashboard extension ships:** whether an `ApiKey` runs as its owner or as a dedicated user, and what the audit trail records for a sale made with it. The plugin e2e test on the supported Vendure range settles it, and the answer is recorded in this ADR.
3. **Implementation order:**
   1. TallyUI `connector-vendure` gains an API-key credential (on the TallyUI lane, for 3.2.0);
   2. the plugin's "POS till" role preset and the API-key e2e test on the supported range;
   3. the Dashboard extension;
   4. the app's device-key sign-in path.

## Consequences

**Work it implies:**
- **TallyUI:** `connector-vendure`'s `vendureAuth` gains an API-key credential (headers `vendure-api-key` and `vendure-token`, no `Authorization`). The app builds its headers through it, today in `lib/session.ts` `sessionContext`. This is a TallyUI request.
- **vendurepos plugin:**
  - a Dashboard extension (Vendure 3.x React Dashboard) for devices;
  - the role preset;
  - an e2e test of key create, use, rotate and delete on the supported Vendure range.
- **vendurepos app:**
  - the device-key sign-in path;
  - the session stores `{ kind: 'api-key', key }` beside today's bearer session. The key is as sensitive as a token and stored the same way (medusapos ADR 0002);
  - sign-out means "forget this device", and does **not** revoke the key.

**Risks:**
- Vendure's API-key feature is young (3.6). Our e2e test is the guard.
- A key in browser storage is long-lived. Revocation from the Dashboard is the answer, and the threat model matches today's year-long bearer session.

**For Paul:** none is expected. API keys are a Vendure core feature, with no licence or pricing consequence. If the Dashboard extension turns out to need the paid Vendure Enterprise Dashboard features, that would be a Paul question. As far as I can read, the 3.x React Dashboard extension API is open source.
