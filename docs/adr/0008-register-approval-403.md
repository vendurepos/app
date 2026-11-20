# The register approval route keeps its 403 for an administrator without the permission

Status: Accepted (records the existing behaviour of #332 / PR #335; no code change)
Date: 2026-11-20

## Context

`POST /tally/v1/register-approvals` (#332, PR #335) takes a manager's username and password from the till's cashier and checks them with Vendure's `NativeAuthenticationStrategy.authenticate`, run in an admin context, without logging the manager in (`src/service/register-approval.service.ts`). It answers:

- **401 `approval_invalid_credentials`** for an unknown username, a customer and a wrong password. These are one answer: the same status, body and headers. The admin context's lookup (`UserService.getUserByEmailAddress`) joins the `administrator` table, so a customer's correct password finds no user. Test 4 in `test/register-approval.e2e.ts` pins this.
- **403 `approval_forbidden`** for an administrator whose password is right but who holds neither `ApproveTallyPosVariance` nor SuperAdmin on the session's channel.

The front desk noted on 2026-11-19 that a 403 confirms the password. It asked for that to be said in an ADR, or for the 403 to be folded into the 401.

Two facts about Vendure 3.7.3 frame the choice:

- **Vendure's own Admin API answers the same question.** Its `login` mutation (`BaseAuthResolver.authenticateAndCreateSession`) returns a session for any administrator whose password is right, whatever their roles, and `InvalidCredentialsError` otherwise. A customer's credentials get `InvalidCredentialsError` too.
- **Vendure core does not rate-limit that mutation.** Nothing in `@vendure/core`'s `dist/api` throttles login.

## Decision

1. **Keep the 403.** It tells a password-holder nothing the store's Admin API `login` does not already tell anyone, and this route asks more of the caller:
   - It needs a till's credentials. The route is behind `TallyPosSell` or `CreateOrder`.
   - It needs a session that is open in the store.
   - It counts every answer that issues no proof as a failure, the 403 included. The pending row stays without a `tokenHash`. The limit is 5 failures per cashier and 10 per username in 15 minutes (`MAX_APPROVAL_FAILURES_PER_ACTOR`, `MAX_APPROVAL_FAILURES_PER_IDENTIFIER`, `APPROVAL_FAILURE_WINDOW_MS`).
2. **Why not fold it into the 401.** The 403 is the only way the till can say "this manager can't approve variances" rather than "wrong password". Without it, a manager whose role lacks the permission would retype a correct password until the per-username limit locks them out for 15 minutes.
3. **Revisit** if a store disables or throttles the Admin API `login` for administrators. On such a store, this route would become the weaker door, and the 403 should then fold into the 401.

## Consequences

- No code change. The README's list of refusals already names the 403. Its known limits (PR #336) say that a 403 or a thrown credential check counts as a failure.
- A store that puts the Admin API behind a network rule (for example, the Dashboard only on a private network) while the till routes stay public exposes this route as a password check that `login` no longer offers. The route's rate limit still bounds it. Point 3 covers that case if a store reports it.
