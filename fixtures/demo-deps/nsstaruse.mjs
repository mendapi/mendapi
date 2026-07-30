// Two-level namespace consumers: `import * as api from './lib/starnsbarrel.mjs'`
// where the barrel itself publishes namespace slots (`export * as coreNs ...`).
// The FIRST chain segment picks the slot, the SECOND dispatches against the
// slot target's (clientmod.mjs) proven export table, remaining segments join
// the entry's prefix — three-segment minimum, pure table dispatch.
import * as api from './lib/starnsbarrel.mjs';

export async function nsTwoLevelPositive(id) {
  // Positive: slot + named entry + chain.
  await api.coreNs.stripeClient.charges.captureNT1(id);
  // Positive: alias-export prefix accumulates through the slot
  // (checkout.sessions.*).
  await api.coreNs.checkoutSessions.listLineItemsNT2(id);
  // Positive: the slot's namespace object carries the target's default member.
  await api.coreNs.default.payouts.cancelNT3(id);
  // Positive (plain-entry precedence): takenNs is a proven PLAIN forwarded
  // entry on the barrel — dispatch stays one-level (surface
  // client.charges.captureNT4, via the plain entry's own table lookup).
  await api.takenNs.charges.captureNT4(id);
}

export async function nsTwoLevelNegative(id) {
  // Negative: ghost entry under a real slot never binds.
  await api.coreNs.ghost.refunds.badNT5(id);
  // Negative: ghost slot never binds.
  await api.ghostSlot.stripeClient.charges.badNT6(id);
  // Negative: two segments only (slot + entry, no member) is a direct call
  // on the entry — no chain to attribute.
  await api.coreNs.stripeClient(id);
  // Negative: call-bearing export member under the slot is API data.
  await api.coreNs.latestCharges.refreshNT7();
  // Negative: bare-package namespace re-export slot never joins.
  await api.vendNs.charges.cancelNT8(id);
}
