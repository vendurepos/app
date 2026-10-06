// The one walk-in placeholder customer shared by every channel. Its own module, so StoreSetupService and
// OrderCreateService share it without importing each other.
export const WALK_IN_EMAIL = 'walk-in@vendurepos.invalid';

// ADR 0005 ruling (a): the plugin-owned variant for custom till lines.
export const TALLY_CUSTOM_ITEM_SKU = 'TALLY-CUSTOM-ITEM';
// ADR 0005 ruling (a): the plugin-owned category for untaxed custom lines.
export const TALLY_NO_TAX_CATEGORY = 'POS no tax';

// The order.create versions the server accepts, independent of vendored/versions.ts.
export const ORDER_CREATE_VERSIONS: readonly number[] = [1, 2, 3, 4, 5];
// What /tally/v1/info advertises: gains 5 when fees, shipping and custom lines are all honoured (ADR 0005),
// so no till sends v5 to a server that would refuse its charges.
export const ADVERTISED_ORDER_CREATE_VERSIONS: readonly number[] = [1, 2, 3, 4];

// The register contract versions this plugin implements (ADR 0003), shared by the five register.* commands; /info
// advertises this list and RegisterService's version gate reads it.
export const REGISTER_VERSIONS: readonly number[] = [1];
