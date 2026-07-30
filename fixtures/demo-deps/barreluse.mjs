// Barrel-consumer fixture: every chain below roots at a client proven in
// lib/clientmod.mjs but reaches this file only THROUGH forwarding barrels
// (lib/barrel.mjs named re-exports, lib/starbarrel.mjs `export *`). No
// provider import exists in this file.
import { stripeClient, fwdSessions, coreClient } from './lib/barrel.mjs';

export function viaBarrel(id) {
  stripeClient.coupons.del(id);
  // alias prefix must survive forwarding: client.checkout.sessions.expireAll
  fwdSessions.expireAll(id);
  // `export { default as coreClient }` maps '@default' to a named handshake:
  return coreClient.balance.retrieveX();
}

// Negative: forwarded call-bearing export must never root a chain.
import { latestCharges } from './lib/barrel.mjs';
export function pokeFwd() {
  return latestCharges.refreshY();
}

// Negative: bare-package forwarding never joins.
import { pkgCharges } from './lib/barrel.mjs';
export function pkgFwd() {
  return pkgCharges.createY({});
}

// Positive: star barrel forwards named members...
import { stripeClient as starClient } from './lib/starbarrel.mjs';
export function viaStar(id) {
  return starClient.plans.del(id);
}

// Negative: ...but per the ESM spec `export *` does NOT forward the default
// export, so a default import of the star barrel must never bind.
import starDefault from './lib/starbarrel.mjs';
export function starDefaultNeg() {
  return starDefault.tokens.createY({});
}
