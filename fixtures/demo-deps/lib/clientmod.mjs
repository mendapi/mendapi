// Cross-module re-export fixture (exporting side): the client is proven here
// (import line + instance construction) and re-exported under named exports.
// Consumers joining these names through a relative import get chain roots
// without any scope tracking — see reexportuse.mjs.
import Stripe from 'stripe';

export const stripeClient = new Stripe(process.env.STRIPE_KEY);

// Alias export: prefix must travel with the export (consumer chains resolve
// to client.checkout.sessions.*).
const sessions = stripeClient.checkout.sessions;
export { sessions as checkoutSessions };

// Negative: call-bearing RHS is API data, never a provable root — exporting
// it must not make it joinable downstream.
export const latestCharges = stripeClient.charges.list();

// Positive: default export of a bare proven identifier IS collected under the
// '@default' sentinel — the module's single default export makes the resolved
// relative specifier itself the handshake (see deps.js collectExports).
export default stripeClient;
