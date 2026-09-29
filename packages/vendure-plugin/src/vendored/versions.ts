// TEMPORARY (spike S1): vendored from medusapos@8667f71 packages/medusa-plugin/src/api/tally/v1/versions.ts until @tallyui/core/server exists.
// The order.create versions this plugin accepts: /info advertises them and processBatch enforces them (one source).
export const SUPPORTED_ORDER_CREATE_VERSIONS: readonly number[] = [1, 2, 3]
// The contract versions shared by all five register commands.
export const SUPPORTED_REGISTER_VERSIONS: readonly number[] = [1]
