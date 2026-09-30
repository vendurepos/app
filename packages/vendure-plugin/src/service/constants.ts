// The one walk-in placeholder customer shared by every channel. Its own module, so StoreSetupService and
// OrderCreateService share it without importing each other.
export const WALK_IN_EMAIL = 'walk-in@vendurepos.invalid';

// The order.create versions this plugin implements. /info and the version gate read only this list, never the vendored
// list in vendored/versions.ts, so re-vendoring cannot advertise or accept a version the plugin has not implemented.
export const ORDER_CREATE_VERSIONS: readonly number[] = [1, 2, 3, 4];

// The register contract versions this plugin implements (ADR 0003), shared by the five register.* commands; /info
// advertises this list and RegisterService's version gate reads it.
export const REGISTER_VERSIONS: readonly number[] = [1];
