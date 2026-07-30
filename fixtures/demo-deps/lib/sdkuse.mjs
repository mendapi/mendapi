// SDK method-chain surface fixture: chains must resolve through the import
// binding + instance variable, never by chain shape alone.
import Cloudflare from 'cloudflare';

const cf = new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN });

export async function readNamespaceValue(nsId, key) {
  return cf.kv.namespaces.values.get(nsId, key);
}

export async function listZones() {
  return cf.zones.list();
}

// Inline constructor chain: the import binding itself roots the chain on one
// line — must be inventoried (no intermediate variable needed). The chain is
// deliberately NOT in any migration table so pack-join counts stay stable.
export async function oneShotAccounts() {
  return new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN }).accounts.list();
}

// Negative: constructor argument list spanning multiple lines — the closing
// paren is not line-anchored evidence, stays on the AST track.
export async function multiLineCtor() {
  return new Cloudflare({
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  }).workers.list();
}

// Negative: bare call without `new` on a default import is a plain function
// call whose return type is not provable here — never inventoried.
export function bareCall() {
  return Cloudflare({ apiToken: 'x' }).dns.records.list();
}

// Negative site: a local registry object exposes the exact same chain shape.
// It has no binding to the cloudflare module and must never be inventoried.
const registry = buildRegistry();
export function localLookup(nsId, key) {
  return registry.kv.namespaces.values.get(nsId, key);
}

// Sub-client alias: a pure member expression assigned from the proven root
// re-roots later chains with the full prefix (dns.records.export below must
// surface as client.dns.records.export).
const dnsRecords = cf.dns.records;
export function exportRecords(zoneId) {
  return dnsRecords.export(zoneId);
}

// Negative: RHS containing a call is API data (real dataflow, AST track) —
// the result variable must never bind, so zoneList.refresh() is never
// inventoried.
const zoneList = cf.zones.list();
export function refreshZones() {
  return zoneList.refresh();
}

// Negative: same-shaped alias off the unrelated local registry never binds.
const localValues = registry.kv.namespaces.values;
export function localValue(nsId, key) {
  return localValues.get(nsId, key);
}

function buildRegistry() {
  return { kv: { namespaces: { values: { get: (a, b) => `${a}:${b}` } } }, zones: { list: () => [] } };
}
