# Requirement for every register.* spec — client-time bounds (TallyUI #325)

**Status:** this is not a job on its own. The plugin has no `register.*` handler yet, and registers and closures come later from the shared WCPOS port (`docs/PLAN.md:198`). **Every spec that adds a `register.*` command to the plugin must include this section unchanged.** This is the Front desk's ruling of 2026-09-30. It is the same rule the plugin already applies to `order.create` since vendurepos/app#63.

## The rule

"Client time" is a contract field kind, defined in TallyUI `docs/contract/field-kinds.md` (TallyUI #325). Each such field is bounded:
- **no earlier than `2020-01-01T00:00:00Z`;**
- **no later than 24 h after the server clock.**

A value outside either bound, or one that cannot be parsed, is **`invalid_payload` naming the field's path**, with the same message shape as `order.create`:
- `<path>: expected a time no earlier than 2020-01-01T00:00:00Z`
- `<path>: expected a time no later than one day from now`

The refusal runs in step 4, after the replay read, so a stored answer still wins. It is unstored, and the time is **never clamped**. Reuse `createdAtError` and its constants in `src/service/order-create.service.ts` (`CREATED_AT_FLOOR_MS`, `CREATED_AT_SKEW_MS`), or move them to a shared module in the same PR. Never copy them.

## The client-time fields, by name (TallyUI #325)

Already enforced by the plugin for `order.create` (#63):
1. the envelope's `createdAt`, on every command;
2. `order.create` `payload.createdAt`.

Each `register.*` spec adds whichever of these its command carries:
3. register session open: `payload.openedAt`
4. register session transition: `payload.at`
5. `register.movement.record`: `payload.createdAt`
6. `register.movement.void`: `payload.createdAt`
7. `register.closure.submit`: `payload.openedAt`
8. `register.closure.submit`: `payload.closedAt`

## Tests each register spec must carry

For every client-time field of its command:
- `1970-01-01T00:00:00Z` and `2019-12-31T23:59:59Z` are refused with the exact floor message, and unstored;
- a time a day plus a minute ahead is refused with the upper-bound message;
- exactly `2020-01-01T00:00:00Z`, and a time a day minus a minute ahead, apply.

**Mutation checks**, rerun by the dispatching session:
- the floor check changed from `<` to `<=`;
- the floor moved to 2019.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
