// The one walk-in placeholder customer shared by every channel. Its own module, so StoreSetupService and
// OrderCreateService share it without importing each other.
export const WALK_IN_EMAIL = 'walk-in@vendurepos.invalid';

// ADR 0005 ruling (a): the plugin-owned variant for custom till lines.
export const TALLY_CUSTOM_ITEM_SKU = 'TALLY-CUSTOM-ITEM';
// ADR 0005 ruling (a): the plugin-owned category for untaxed custom lines.
export const TALLY_NO_TAX_CATEGORY = 'POS no tax';

// The order.create versions the server accepts (the plugin's own list; nothing is vendored for it).
export const ORDER_CREATE_VERSIONS: readonly number[] = [1, 2, 3, 4, 5];
// Fees, shipping and custom lines are honoured (ADR 0005), so /tally/v1/info advertises every accepted version.
export const ADVERTISED_ORDER_CREATE_VERSIONS: readonly number[] = ORDER_CREATE_VERSIONS;

// The register contract versions this plugin implements (ADR 0003), shared by the five register.* commands; /info
// advertises this list and RegisterService's version gate reads it. Version 2 is ADR-078's take-over and resume.
export const REGISTER_VERSIONS: readonly number[] = [1, 2];

// ADR 0007: the order.refund versions this plugin implements; /info advertises them and RefundService gates on them.
export const ORDER_REFUND_VERSIONS: readonly number[] = [1];

// ADR 0005 ruling (b): one shipping charge per order. /tally/v1/info advertises it and the strict shape check enforces it.
export const MAX_SHIPPING_LINES = 1;

// The SKUs of the surcharges order.create writes (ADR 0005): a fee, a line discount and the tax rounding bridge.
// They are stored on orders, and order.create's fiscal check reads the fee and discount back, so they never change.
export const TALLY_FEE_SKU = 'TALLY-FEE';
export const TALLY_DISCOUNT_SKU = 'TALLY-DISCOUNT';
export const TALLY_ROUNDING_SKU = 'TALLY-ROUNDING';

// Postgres two-int advisory lock namespaces: (namespace, key) keys stay apart from other plugins' single-bigint keys,
// and these three must stay distinct from each other.
// StoreSetupService: the key (SETUP_LOCK_NAMESPACE, 0) is deliberately global, not per channel: the POS methods and
// the walk-in are rows shared by every channel.
export const SETUP_LOCK_NAMESPACE = 0x7a11;
// Ruling 14: (CUSTOMER_LOCK_NAMESPACE, hashtext(email)) serialises creating a customer per email.
export const CUSTOMER_LOCK_NAMESPACE = 0x7a12;
// ADR 0003: (REGISTER_LOCK_NAMESPACE, hashtext of the channel and register) serialises a register's commands across
// tills and instances.
export const REGISTER_LOCK_NAMESPACE = 0x7a13;
