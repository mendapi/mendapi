// Consumers of the ESM namespace re-export barrel (starnsbarrel.mjs).
// The imported slot is a namespace binding: chains dispatch their first
// segment against clientmod.mjs's proven export table.
import { coreNs, takenNs, vendNs } from './lib/starnsbarrel.mjs';

export async function starNsPositive(id) {
  // Positive: named member of the namespace slot roots a chain.
  await coreNs.stripeClient.radar.earlyFraudWarnings.retrieveSN(id);
  // Positive: alias-export prefix accumulates (checkout.sessions.*).
  await coreNs.checkoutSessions.listLineItemsSN(id);
  // Positive: the namespace object carries the target's default member.
  await coreNs.default.applicationFees.retrieveSN(id);
}

export async function starNsNegative(id) {
  // Negative: member absent from the proven table never binds.
  await coreNs.ghost.charges.confirmSN1({});
  // Negative: call-bearing export member is API data, never a root.
  await coreNs.latestCharges.refreshSN2();
  // Negative: single-segment call has no chain to attribute.
  await coreNs.pingSN3();
  // Negative (plain-entry precedence): takenNs is a proven PLAIN forwarded
  // entry (stripeClient) — never a namespace slot. The chain roots on the
  // plain binding (surface client.stripeClient.charges.captureSN4), proving
  // the namespace re-export did not overwrite the proven name (a namespace
  // dispatch would have produced client.charges.captureSN4 instead).
  await takenNs.stripeClient.charges.captureSN4({});
  // Negative: bare-package namespace re-export never joins.
  await vendNs.charges.cancelSN5({});
}
