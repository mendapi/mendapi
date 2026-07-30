// Re-export forwarding fixture (barrel file): this file constructs nothing —
// it only forwards entries of clientmod.mjs's proven export table. Consumers
// importing through this barrel must resolve exactly as if they imported the
// exporting file directly (bounded-fixpoint forwarding in deps.js).
export { stripeClient, checkoutSessions as fwdSessions } from './clientmod.mjs';
export { default as coreClient } from './clientmod.mjs';

// Negative: forwarding a call-bearing export never creates a joinable root
// downstream (latestCharges is API data, not a client).
export { latestCharges } from './clientmod.mjs';

// Negative: bare-package forwarding never joins the module graph.
export { charges as pkgCharges } from 'unrelated-package';
