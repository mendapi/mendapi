// ESM namespace re-export fixture: `export * as ns from './rel'` publishes
// clientmod.mjs's module namespace object under a named slot. Consumers that
// import the slot by name dispatch chains against clientmod's proven export
// table (default included, via the `default` member). See starnsuse.mjs.
export * as coreNs from './clientmod.mjs';

// Negative: a namespace re-export never overwrites a proven own name — the
// forwarded proven entry wins (duplicate export names are a syntax error in
// real modules; the guard is defensive). The consumer never dispatches
// takenNs as a namespace slot.
export { stripeClient as takenNs } from './clientmod.mjs';
export * as takenNs from './clientmod.mjs';

// Negative: bare-package namespace re-export never joins the module graph.
export * as vendNs from 'stripe';
