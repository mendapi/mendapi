// Cross-module re-export fixture (consuming side): this file has NO provider
// import of its own — every chain below roots at a client proven in
// lib/clientmod.mjs and joined through the named import (module-graph join,
// two line-anchored facts composed).
import { stripeClient, checkoutSessions as co } from './lib/clientmod.mjs';

export function refund(chargeId) {
  return stripeClient.disputes.retrieve(chargeId);
}

// Alias prefix must accumulate: surfaces as client.checkout.sessions.expire.
export function expireSession(id) {
  return co.expire(id);
}

// Negative: call-bearing export never becomes a root — refresh() below must
// never surface (latestCharges stays on the AST track).
import { latestCharges } from './lib/clientmod.mjs';
export function poke() {
  return latestCharges.refresh();
}

// Positive: default import binds through the '@default' sentinel — the
// resolved relative specifier is the handshake (per-module singleton).
import defaultClient from './lib/clientmod.mjs';
export function viaDefault() {
  return defaultClient.customers.create({});
}

// Negative: bare-package specifier never joins the repo module graph.
import { charges } from 'unrelated-package';
export function unrelated() {
  return charges.create({});
}

// Positive: mixed default + named import on one anchored line — the default
// segment joins via '@default', the named segment via the exported-name
// handshake (alias prefix must still accumulate).
import mixedDef, { checkoutSessions as mco } from './lib/clientmod.mjs';
export function mixedForms(id) {
  mixedDef.payouts.cancel(id);
  return mco.retrieve(id);
}

// Positive: namespace import — the binding carries the exporting file's whole
// proven export table; chains dispatch on their first segment. Named member,
// alias-prefixed member, and the 'default' member (via the '@default'
// sentinel) must all resolve. Members not in the export table (including the
// call-bearing latestCharges) must never bind.
import * as nsApi from './lib/clientmod.mjs';
export function nsForms(id) {
  nsApi.stripeClient.transfers.create({ amount: id });
  nsApi.checkoutSessions.list({ limit: 3 });
  return nsApi.default.topups.create({ amount: id });
}
export function nsNegatives() {
  nsApi.latestCharges.refreshZ(); // call-bearing export: not in the table
  return nsApi.missing.fooQ({}); // never exported: must not bind
}
