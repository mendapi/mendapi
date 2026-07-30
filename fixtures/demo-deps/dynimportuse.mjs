// Dynamic-import consumer fixture: every chain below roots at a client
// proven in lib/clientmod.mjs, joined through `await import()` — the module
// namespace object's members are exactly the target's line-proven export
// table (same table-dispatch insight as `import * as`).

// Positive: namespace binding — full-table dispatch on first chain segment.
const dynMod = await import('./lib/clientmod.mjs');
export function dynNs() {
  return dynMod.stripeClient.transfers.createDA({});
}
// Alias prefix travels: surfaces as client.checkout.sessions.expireDA.
export function dynNsAlias(id) {
  return dynMod.checkoutSessions.expireDA(id);
}

// Positive: head selection (with '.default' ESM-interop head).
const dynPay = (await import('./lib/clientmod.mjs')).default;
export function dynProp() {
  return dynPay.payouts.listDA();
}

// Positive: destructure with alias key.
const { stripeClient: dsc } = await import('./lib/clientmod.mjs');
export function dynDestr() {
  return dsc.balance.retrieveDA();
}

// Negative: expression tail never binds.
const dynExpr = (await import('./lib/clientmod.mjs')).stripeClient || {};
export function dynExprUse() {
  return dynExpr.charges.createDX({});
}

// Negative: promise tail (no await) never binds.
const dynThen = import('./lib/clientmod.mjs').then((m) => m.stripeClient);
export function dynThenUse() {
  return dynThen.charges.createDY({});
}

// Negative: missing head never binds.
const dynMiss = (await import('./lib/clientmod.mjs')).nopeHere;
export function dynMissUse() {
  return dynMiss.charges.createDZ({});
}

// Negative: dynamic specifier is never provable.
const dynSpec = './lib/clientmod.mjs';
const dynVar = await import(dynSpec);
export function dynVarUse() {
  return dynVar.stripeClient.charges.createDW({});
}

// Negative: destructure key with a default value is not a pure member pick.
const { stripeClient: dynDef = {} } = await import('./lib/clientmod.mjs');
export function dynDefUse() {
  return dynDef.charges.createDV({});
}

// Negative: another line-anchored declaration of the same local shadows the
// dynamic binding (guard rejects; only the import statement itself is exempt).
const dynShadow = (await import('./lib/clientmod.mjs')).stripeClient;
export function dynShadowUse() {
  const dynShadow = makeLocalThing();
  return dynShadow.charges.createDU({});
}

// Negative: string lookalike never resolves.
export const dynStr = "const dynS = await import('./lib/clientmod.mjs');";

// --- Destructure of a head-selected dynamic import (Loop 183) ---
// Positive: plain key + alias key on a head-selected namespace entry.
const { terminal: dpTerm, charges: dpCharges } = (await import('./lib/clientmod.mjs')).stripeClient;
export function dynDestrPropAlias() {
  return dpTerm.readers.cancelActionDP();
}
export function dynDestrPropPlain() {
  return dpCharges.createDP({});
}
// Positive: '.default' head maps to the '@default' sentinel (ESM interop).
const { payouts: dpPoList } = (await import('./lib/clientmod.mjs')).default;
export function dynDestrPropDefault() {
  return dpPoList.listDP();
}
// Negative: expression tail after the selection never binds.
const { charges: dpExpr } = (await import('./lib/clientmod.mjs')).stripeClient || {};
export function dynDestrPropExpr() {
  return dpExpr.createDPX({});
}
// Negative: missing head never binds.
const { charges: dpMiss } = (await import('./lib/clientmod.mjs')).nopeHead;
export function dynDestrPropMiss() {
  return dpMiss.createDPY({});
}
// Negative: default-value key is not a pure member pick.
const { charges: dpDef = {} } = (await import('./lib/clientmod.mjs')).stripeClient;
export function dynDestrPropDef() {
  return dpDef.createDPZ({});
}
// Negative: another line-anchored declaration of the same local shadows it.
const { charges: dpShadow } = (await import('./lib/clientmod.mjs')).stripeClient;
export function dynDestrPropShadow() {
  const dpShadow = makeLocalThing();
  return dpShadow.createDPU({});
}
// Negative: string lookalike never resolves.
export const dpStr = "const { charges: dpS } = (await import('./lib/clientmod.mjs')).stripeClient;";

function makeLocalThing() { return { charges: { createDU: () => null } }; }

// --- Promise-chain consumption (Loop 187): import('./rel').then(m => m.head.chain(...)) ---
// Positive: named head dispatches the proven export table.
export function dynThenNamed() {
  return import('./lib/clientmod.mjs').then(m => m.stripeClient.disputes.closeDT('dp_1'));
}
// Positive: alias-export prefix travels (surfaces as client.checkout.sessions.expireDT).
export function dynThenAliasPrefix(id) {
  return import('./lib/clientmod.mjs').then(mod => mod.checkoutSessions.expireDT(id));
}
// Positive: 'default' head maps to the '@default' sentinel (parenthesized param).
export function dynThenDefault() {
  return import('./lib/clientmod.mjs').then((m) => m.default.topups.listDT());
}
// Positive (flipped Loop 235): block-body callback with a single chained
// statement binds — the param is still the module namespace object.
export function dynThenBlock() {
  return import('./lib/clientmod.mjs').then(m => { return m.stripeClient.charges.createDT1({}); });
}
// --- Block-body promise-chain consumption (Loop 235) ---
// Positive: multi-statement async block body — every param-rooted chain binds.
export function dynThenBlockMulti() {
  return import('./lib/clientmod.mjs').then(async (m) => {
    const amount = 500;
    await m.stripeClient.paymentIntents.createBB1({ amount });
    m.stripeClient.transfers.listBB2();
  });
}
// Positive: alias-export prefix travels inside the block too.
export function dynThenBlockAlias(id) {
  return import('./lib/clientmod.mjs').then((mod) => {
    mod.checkoutSessions.expireBB3(id);
  });
}
// Negative: nested arrow inside the block drops the whole body (shadow risk).
export function dynThenBlockNested() {
  return import('./lib/clientmod.mjs').then((m) => {
    const run = (m) => m.stripeClient.charges.createBB4({});
    run(null);
  });
}
// Negative: param reassignment inside the block drops the whole body.
export function dynThenBlockReassign() {
  return import('./lib/clientmod.mjs').then((m) => {
    m = makeLocalThing();
    m.stripeClient.charges.createBB5({});
  });
}
// Negative: string/comment lookalikes inside the block never bind.
export function dynThenBlockProse() {
  return import('./lib/clientmod.mjs').then((m) => {
    // m.stripeClient.charges.createBB6({})
    const s = "m.stripeClient.charges.createBB7({})";
    return s.length + (m ? 1 : 0);
  });
}
// Negative: chain not rooted at the param never binds (member position).
export function dynThenBlockWrongRoot(other) {
  return import('./lib/clientmod.mjs').then((m) => {
    other.m.stripeClient.charges.createBB8({});
  });
}
// --- Function-expression promise-chain callbacks (Loop 237) ---
// Positive: classic anonymous function expression — block body, same
// namespace-param proof as the arrow forms.
export function dynThenFnExpr() {
  return import('./lib/clientmod.mjs').then(function (m) {
    return m.stripeClient.paymentIntents.createFE1({ amount: 5 });
  });
}
// Positive: async function expression, multi-statement body.
export function dynThenFnExprAsync() {
  return import('./lib/clientmod.mjs').then(async function (m) {
    const n = 1;
    await m.stripeClient.transfers.listFE2({ limit: n });
  });
}
// Positive: named function expression — alias-export prefix travels
// (surfaces as client.checkout.sessions.expireFE3).
export function dynThenFnExprNamed(id) {
  return import('./lib/clientmod.mjs').then(function onMod(m) {
    m.checkoutSessions.expireFE3(id);
  });
}
// Negative: nested function inside the body drops the whole block.
export function dynThenFnExprNested() {
  return import('./lib/clientmod.mjs').then(function (m) {
    function run(m) { return m.stripeClient.charges.createFE4({}); }
    return run(null);
  });
}
// Negative: param reassignment inside the body drops the whole block.
export function dynThenFnExprReassign() {
  return import('./lib/clientmod.mjs').then(function (m) {
    m = makeLocalThing();
    m.stripeClient.charges.createFE5({});
  });
}
// Negative: the expression's own name is the function, never the namespace.
export function dynThenFnExprSelfRef() {
  return import('./lib/clientmod.mjs').then(function self(m) {
    return self.stripeClient ? null : (m ? 1 : 0) + (self.charges ? 0 : 1) + (0 && self.stripeClient.charges.createFE6({}));
  });
}
// Negative: string lookalike never resolves.
export const feStr = "import('./lib/clientmod.mjs').then(function (m) { m.stripeClient.charges.createFE7({}); })";
// Negative: chain not rooted at the arrow param never binds.
export function dynThenWrongRoot(other) {
  return import('./lib/clientmod.mjs').then(m => other.stripeClient.charges.createDT2({}));
}
// Negative: member absent from the export table never binds.
export function dynThenGhost() {
  return import('./lib/clientmod.mjs').then(m => m.nopeHead.charges.createDT3({}));
}
// Negative: dynamic specifier never resolves.
export function dynThenDynSpec(p) {
  return import(p).then(m => m.stripeClient.charges.createDT4({}));
}
// Negative: string lookalike never resolves.
export const dtStr = "import('./lib/clientmod.mjs').then(m => m.stripeClient.charges.createDT5({}))";
// Negative: single segment after the param (no dispatch key + method).
export function dynThenSingle() {
  return import('./lib/clientmod.mjs').then(m => m.pingDT6());
}
// Negative: call-bearing export member (API data) never binds downstream.
export function dynThenCallBearing() {
  return import('./lib/clientmod.mjs').then(m => m.latestCharges.refreshDT7());
}

// --- Dynamic import over a slot-publishing barrel (Loop 192) ---
// lib/starnsbarrel.mjs publishes clientmod.mjs's namespace under the coreNs
// slot (`export * as coreNs ...`). The dynamic forms dispatch identically to
// their static twins: slot lookup, then table dispatch — never value
// semantics.

// Positive: namespace binding over the barrel — two-level dispatch
// (mod.slot.entry.<chain>, three segments minimum).
const dnMod = await import('./lib/starnsbarrel.mjs');
export function dynNsSlot() {
  return dnMod.coreNs.stripeClient.charges.captureDN1({});
}
// Positive (plain-entry precedence): takenNs is a proven plain forwarded
// entry on the barrel — dispatch stays one-level.
export function dynNsSlotPrecedence() {
  return dnMod.takenNs.charges.captureDN2({});
}
// Positive: head selection where the head is a namespace slot — single
// segment binds the slot target's namespace (full-table dispatch).
const dnPay = (await import('./lib/starnsbarrel.mjs')).coreNs;
export function dynPropSlotNs() {
  return dnPay.stripeClient.disputes.closeDN3('dp');
}
// Positive: `.slot.entry` selection — second segment dispatches the slot
// target's table (alias prefix travels: checkout.sessions.*).
const dnSess = (await import('./lib/starnsbarrel.mjs')).coreNs.checkoutSessions;
export function dynPropSlotEntry(id) {
  return dnSess.expireDN4(id);
}
// Positive: destructured slot key carries the slot target's namespace.
const { coreNs: dnNs } = await import('./lib/starnsbarrel.mjs');
export function dynDestrSlot() {
  return dnNs.stripeClient.transfers.createDN5({});
}
// Positive: destructure off a slot head — per-key table dispatch.
const { stripeClient: dnSc } = (await import('./lib/starnsbarrel.mjs')).coreNs;
export function dynDestrPropSlot() {
  return dnSc.balance.retrieveDN6();
}
// Negative: ghost slot never binds.
export function dynNsGhostSlot() {
  return dnMod.ghostSlot.stripeClient.charges.badDN7({});
}
// Negative: ghost entry under a real slot never binds.
export function dynNsGhostEntry() {
  return dnMod.coreNs.ghostEntry.charges.badDN8({});
}
// Negative: head-of-slot with ghost second segment never binds.
const dnBad = (await import('./lib/starnsbarrel.mjs')).coreNs.ghostEntry;
export function dynPropSlotGhost() {
  return dnBad.badDN9({});
}
// Negative: destructure ghost key off a slot head never binds.
const { ghostKey: dnGk } = (await import('./lib/starnsbarrel.mjs')).coreNs;
export function dynDestrPropSlotGhost() {
  return dnGk.charges.badDN10({});
}
// Negative: expression tail on a slot selection never binds.
const dnExprSlot = (await import('./lib/starnsbarrel.mjs')).coreNs || {};
export function dynPropSlotExpr() {
  return dnExprSlot.stripeClient.charges.badDN11({});
}
// Negative: bare-package namespace re-export slot never joins.
export function dynNsVendorSlot() {
  return dnMod.vendNs.charges.badDN12({});
}
// --- Loop 193: promise-chain over a slot-publishing barrel ---
// Positive: .then head-of-slot + entry + member — two-level table dispatch.
export function dynThenSlotNamed() {
  return import('./lib/starnsbarrel.mjs').then(m => m.coreNs.stripeClient.mandates.retrieveTS1('m_1'));
}
// Positive: alias-export entry under the slot carries its prefix.
export function dynThenSlotAlias() {
  return import('./lib/starnsbarrel.mjs').then(m => m.coreNs.checkoutSessions.listLineItemsTS2('cs_1'));
}
// Positive: slot default member joins the target's @default sentinel.
export function dynThenSlotDefault() {
  return import('./lib/starnsbarrel.mjs').then(m => m.coreNs.default.applicationFees.captureTS3('fee_1'));
}
// Negative: ghost slot never binds.
export function dynThenGhostSlot() {
  return import('./lib/starnsbarrel.mjs').then(m => m.ghostSlot.stripeClient.charges.badTS4({}));
}
// Negative: ghost entry under a real slot never binds.
export function dynThenGhostEntry() {
  return import('./lib/starnsbarrel.mjs').then(m => m.coreNs.ghostEntry.charges.badTS5({}));
}
// Negative: slot + entry with no member (two segments) never binds.
export function dynThenSlotTwoSegs() {
  return import('./lib/starnsbarrel.mjs').then(m => m.coreNs.stripeClient());
}
// Positive (flipped Loop 235): block body over a slot barrel binds too —
// the two-level table dispatch carries the same proof inside the block.
export function dynThenSlotBlockBody() {
  return import('./lib/starnsbarrel.mjs').then(m => { return m.coreNs.stripeClient.charges.captureTS6({}); });
}

// --- Parallel dynamic imports via Promise.all positional destructure (Loop 238) ---
// Positive: each pattern element is the namespace of the same-position
// literal import; full-table dispatch plus alias prefix both travel.
const [paMod, paOther] = await Promise.all([
  import('./lib/clientmod.mjs'),
  import('./lib/other.js'),
]);
export function paFirst() {
  return paMod.stripeClient.invoices.voidPA1('in_1');
}
export function paAlias() {
  return paMod.checkoutSessions.expirePA2('cs_1');
}
// Positive: elision hole skips its position; later element still binds.
const [, paHole] = await Promise.all([import('./lib/other.js'), import('./lib/clientmod.mjs')]);
export function paHoleUse() {
  return paHole.stripeClient.payouts.cancelPA3('po_1');
}
// Negative: a non-import element breaks positional provability — whole drop.
const [paBadA, paBadB] = await Promise.all([import('./lib/clientmod.mjs'), globalThis.fetchCfg?.()]);
export function paBadUse() {
  return paBadA.stripeClient.charges.createPA4({}) || paBadB;
}
// Negative: default value is not a pure namespace binding for that element.
const [paDef = {}] = await Promise.all([import('./lib/clientmod.mjs')]);
export function paDefUse() {
  return paDef.stripeClient.charges.createPA5({});
}
// Negative: nested pattern drops the whole statement.
const [[paNest], paNest2] = await Promise.all([import('./lib/clientmod.mjs'), import('./lib/clientmod.mjs')]);
export function paNestUse() {
  return (paNest ? 1 : 0) + (0 && paNest2.stripeClient.charges.createPA6({}));
}
// Negative: string lookalike never resolves.
export const paStr = "const [m] = await Promise.all([import('./lib/clientmod.mjs')]); m.stripeClient.charges.createPA7({})";

// --- Promise-stored dynamic import consumption (Loop 242) ---
// Positive: the promise variable's `.then` param IS the module namespace —
// concise arrow body dispatches the proven export table.
const pvClients = import('./lib/clientmod.mjs');
export function pvConcise() {
  return pvClients.then(m => m.stripeClient.topups.createPV1({}));
}
// Positive: alias prefix travels through the stored promise (block body).
export function pvBlock() {
  return pvClients.then((m) => { return m.checkoutSessions.expirePV2('cs_1'); });
}
// Positive: function-expression callback on the stored promise binds too.
const pvFn = import('./lib/clientmod.mjs');
export function pvFuncExpr() {
  return pvFn.then(function (m) { return m.stripeClient.payouts.cancelPV3('po_1'); });
}
// Negative: reassigned promise variable drops file-wide.
let pvRe = import('./lib/clientmod.mjs');
pvRe = null;
export function pvReUse() {
  return pvRe && pvRe.then(m => m.stripeClient.charges.createPV4({}));
}
// Negative: declaration with a `.then` tail is not a pure promise binding.
const pvTail = import('./lib/clientmod.mjs').then(m => m);
export function pvTailUse() {
  return pvTail.then(m => m.stripeClient.charges.createPV5({}));
}
// Negative: commented usage never binds (prose-blanked scan).
const pvCom = import('./lib/clientmod.mjs');
// pvCom.then(m => m.stripeClient.charges.createPV6({}))
export function pvComUse() {
  return pvCom;
}
// Negative: wrong root inside the callback never binds.
export function pvWrongRoot(other) {
  return pvClients.then(m => other.m.stripeClient.charges.createPV7({}));
}

// --- Awaited-namespace variable from a stored promise (Loop 243) ---
// Positive: `const ns = await pv;` transfers the namespace identity — chains
// on the awaited variable dispatch the proven export table.
export async function avPlain() {
  const avNs = await pvClients;
  return avNs.stripeClient.transfers.createAV1({});
}
// Positive: alias-export prefix travels through the awaited variable too.
export async function avAlias() {
  const avAl = await pvFn;
  return avAl.checkoutSessions.expireAV2('cs_2');
}
// Negative: reassigned awaited variable drops file-wide.
export async function avReassigned() {
  let avRe2 = await pvClients;
  avRe2 = null;
  return avRe2 && avRe2.stripeClient.charges.createAV3({});
}
// Flipped to positive in Loop 244: destructured head from a stored promise is
// the same per-key table dispatch as `const {...} = await import('./rel')`.
export async function avDestructured() {
  const { stripeClient: avSc } = await pvClients;
  return avSc.charges.createAV4({});
}
// Negative: commented usage never binds (prose-blanked scan).
export async function avCommented() {
  const avCom = await pvClients;
  // avCom.stripeClient.charges.createAV5({})
  return avCom;
}
// Negative: name reused in parameter position anywhere drops the binding.
export async function avShadowed() {
  const avSh = await pvClients;
  [1].map((avSh) => avSh);
  return avSh.stripeClient.charges.createAV6({});
}

// --- Destructured head from a stored promise (Loop 244) ---
// Positive: pure member pick off the awaited promise variable dispatches the
// proven export table — same per-key proof as `const {...} = await import()`.
export async function dpAlias() {
  const { checkoutSessions: dpCk } = await pvFn;
  return dpCk.expireDP1('cs_9');
}
// Negative: default value in the pattern is not a pure member pick.
export async function dpDefault() {
  const { stripeClient: dpDef = null } = await pvClients;
  return dpDef.charges.createDP2({});
}
// Negative: rest element is not a pure member pick.
export async function dpRest() {
  const { ...dpR } = await pvClients;
  return dpR.stripeClient.charges.createDP3({});
}
// Negative: local reassigned elsewhere drops file-wide.
export async function dpReassigned() {
  let { stripeClient: dpRe } = await pvClients;
  dpRe = null;
  return dpRe && dpRe.charges.createDP4({});
}
// Negative: local in parameter position anywhere drops the binding.
export async function dpShadowed() {
  const { stripeClient: dpSh } = await pvClients;
  [1].map((dpSh) => dpSh);
  return dpSh.charges.createDP5({});
}

// --- Destructured pick off a trailing selection on the awaited stored
// promise (Loop 245): `const { a } = (await pv).head.tail;` — statement head
// dispatches the proven export table, keys join the entry's prefix. ---
// Positive: head pick off the awaited promise's default-adjacent named export.
export async function ppHead() {
  const { charges: ppCh } = (await pvClients).stripeClient;
  return ppCh.capturePP1('ch_7');
}
// Positive: alias prefix travels — head+tail selection then key join.
export async function ppTail() {
  const { sessions: ppSs } = (await pvClients).stripeClient.checkout;
  return ppSs.expirePP2('cs_7');
}
// Negative: default value in the pattern is not a pure member pick.
export async function ppDefault() {
  const { charges: ppDef = null } = (await pvClients).stripeClient;
  return ppDef.capturePP3('x');
}
// Negative: ghost head never binds.
export async function ppGhost() {
  const { charges: ppGh } = (await pvClients).ghostHead;
  return ppGh.capturePP4('x');
}
// Negative: local in parameter position anywhere drops the binding.
export async function ppShadowed() {
  const { charges: ppSh } = (await pvClients).stripeClient;
  [1].map((ppSh) => ppSh);
  return ppSh.capturePP5('x');
}

// --- Plain variable bound to a trailing selection on the awaited stored
// promise (Loop 246): `const x = (await pv).head.tail;` — the non-destructure
// sibling of the Loop 245 form. Statement head dispatches the proven export
// table; usage chains join the entry's prefix. ---
// Positive: head pick then usage chain joins.
export async function pxHead() {
  const pxCl = (await pvClients).stripeClient;
  return pxCl.transfers.reversePX1('tr_1');
}
// Positive: deeper trailing tail joins prefix before usage segments.
export async function pxTail() {
  const pxCk = (await pvFn).stripeClient.checkout;
  return pxCk.sessions.expirePX2('cs_8');
}
// Negative: ghost head never binds.
export async function pxGhost() {
  const pxGh = (await pvClients).ghostHead;
  return pxGh.charges.capturePX3('x');
}
// Negative: local reassigned elsewhere drops file-wide.
export async function pxReassigned() {
  let pxRe = (await pvClients).stripeClient;
  pxRe = null;
  return pxRe && pxRe.charges.capturePX4('x');
}
// Negative: local in parameter position anywhere drops the binding.
export async function pxShadowed() {
  const pxSh = (await pvClients).stripeClient;
  [1].map((pxSh) => pxSh);
  return pxSh.charges.capturePX5('x');
}

// --- Positional destructure of Promise.all over stored promise variables
// (Loop 247): `const [ma, mb] = await Promise.all([pa, pb]);` — the
// stored-promise twin of the inline Promise.all form. Every array element
// must be a guard-surviving promise variable; each pattern element binds the
// matching module namespace. ---
// Positive: two proven promise vars, full-table dispatch per position.
export async function pqPair() {
  const [pqA, pqB] = await Promise.all([pvClients, pvFn]);
  return pqA.stripeClient.topups.createPQ1({}) + pqB.checkoutSessions.expirePQ2('cs_9');
}
// Positive: elision hole skips its position, later binding still lands.
export async function pqHole() {
  const [, pqC] = await Promise.all([pvClients, pvFn]);
  return pqC.stripeClient.payouts.cancelPQ3('po_9');
}
// Negative: non-proven array element drops the whole statement.
export async function pqMixed() {
  const [pqD, pqE] = await Promise.all([pvClients, Promise.resolve(1)]);
  return pqD.stripeClient.charges.capturePQ4('x') + pqE;
}
// Negative: default in the pattern is not a pure namespace binding.
export async function pqDefault() {
  const [pqF = null] = await Promise.all([pvClients]);
  return pqF.stripeClient.charges.capturePQ5('x');
}
// Negative: local in parameter position anywhere drops the binding.
export async function pqShadowed() {
  const [pqG] = await Promise.all([pvClients]);
  [1].map((pqG) => pqG);
  return pqG.stripeClient.charges.capturePQ6('x');
}

// --- Mixed stored/inline Promise.all positional destructure (Loop 248):
// `const [ma, mb] = await Promise.all([pa, import('./b')]);` — a stored
// proven promise variable and a literal relative import() in the same array
// are the same positional proof. Any other element kind drops the whole
// statement. ---
// Positive: stored var + inline literal import, both positions bind.
export async function pmMixedPos() {
  const [pmA, pmB] = await Promise.all([pvClients, import('./lib/clientmod.mjs')]);
  return pmA.stripeClient.transfers.reversePM1('tr_1') + pmB.stripeClient.charges.capturePM2('ch_1');
}
// Positive: hole skips the stored position, inline element still binds with
// alias prefix travel.
export async function pmAliasPos() {
  const [, pmC] = await Promise.all([pvClients, import('./lib/clientmod.mjs')]);
  return pmC.checkoutSessions.expirePM3('cs_2');
}
// Negative: bare-package import element (not a literal RELATIVE import)
// drops the whole statement.
export async function pmBarePkg() {
  const [pmD, pmE] = await Promise.all([pvClients, import('stripe')]);
  return pmD.stripeClient.charges.capturePM4('x') + pmE;
}
// Negative: arbitrary expression element drops the whole statement.
export async function pmExpr() {
  const [pmF] = await Promise.all([pvClients.then((x) => x)]);
  return pmF.stripeClient.charges.capturePM5('x');
}

// --- Destructured `.then` callback param (Loop 249):
// `import('./rel').then(({ key: local }) => local.chain(...))` — the callback
// destructures the module namespace object, so each key is the same pure
// member pick as the awaited destructure form, carried into the promise
// callback. Impure picks / ghost keys / rebindings never bind. ---
// Positive: concise body, alias key carries the export prefix.
export function tdAlias() {
  return import('./lib/clientmod.mjs').then(({ checkoutSessions: tdCS }) => tdCS.expireTD1('cs_1'));
}
// Positive: block body, default key joins '@default'.
export function tdDefault() {
  return import('./lib/clientmod.mjs').then(({ default: tdD }) => { tdD.payouts.listTD2(); });
}
// Positive: block body, plain key, multiple statements.
export function tdBlock() {
  return import('./lib/clientmod.mjs').then(({ stripeClient: tdSC }) => {
    tdSC.transfers.createTD3({});
    tdSC.charges.captureTD4('ch_1');
  });
}
// Negative: default value in the pattern is not a pure member pick.
export function tdDefVal() {
  return import('./lib/clientmod.mjs').then(({ stripeClient: tdE = null }) => tdE.charges.captureTD5('x'));
}
// Negative: ghost key never binds.
export function tdGhost() {
  return import('./lib/clientmod.mjs').then(({ nopeHere: tdF }) => tdF.charges.captureTD6('x'));
}
// Negative: reassignment inside the block drops that local.
export function tdReassign() {
  return import('./lib/clientmod.mjs').then(({ stripeClient: tdG }) => { tdG = {}; tdG.charges.captureTD7('x'); });
}
// Negative: nested arrow in the block drops the whole body.
export function tdNested() {
  return import('./lib/clientmod.mjs').then(({ stripeClient: tdH }) => { [1].map((tdH) => tdH); tdH.charges.captureTD8('x'); });
}

// --- Destructured `.then` callback param on a stored promise (Loop 250):
// `pv.then(({ key: local }) => local.chain(...))` — the stored-promise twin of
// the inline destructured `.then` forms (Loop 249). Each pure member pick
// dispatches on the proven export table; impure picks / ghost keys /
// rebindings never bind. ---
// Positive: concise body, alias key carries the export prefix.
export function spAlias() {
  return pvClients.then(({ checkoutSessions: spCS }) => spCS.expireSP1('cs_1'));
}
// Positive: concise body, default key joins '@default'.
export function spDefault() {
  return pvClients.then(({ default: spD }) => spD.payouts.cancelSP2());
}
// Positive: block body, plain key, multiple statements.
export function spBlock() {
  return pvClients.then(({ stripeClient: spSC }) => {
    spSC.transfers.reverseSP3({});
    spSC.charges.captureSP4('ch_1');
  });
}
// Negative: default value in the pattern is not a pure member pick.
export function spDefVal() {
  return pvClients.then(({ stripeClient: spE = null }) => spE.charges.captureSP5('x'));
}
// Negative: ghost key never binds.
export function spGhost() {
  return pvClients.then(({ nopeHere: spF }) => spF.charges.captureSP6('x'));
}
// Negative: reassignment inside the block drops that local.
export function spReassign() {
  return pvClients.then(({ stripeClient: spG }) => { spG = {}; spG.charges.captureSP7('x'); });
}
// Negative: nested arrow in the block drops the whole body.
export function spNested() {
  return pvClients.then(({ stripeClient: spH }) => { [1].map((spH) => spH); spH.charges.captureSP8('x'); });
}

// --- Function-expression destructured `.then` callback param (Loop 251):
// `.then(function ({ key: local }) { local.chain(...); })` — the function-
// expression twin of the arrow destructured forms (Loop 249/250). Function
// expressions have no concise body, so only the block shape exists; the
// same per-key pure-pick judgement and honest-drop set apply. ---
// Positive: inline import, anonymous function expression, plain key.
export function fdInline() {
  return import('./lib/clientmod.mjs').then(function ({ stripeClient: fdA }) { fdA.taxRates.createFD1({}); });
}
// Positive: inline import, named function expression, alias key carries prefix.
export function fdNamed() {
  return import('./lib/clientmod.mjs').then(function pick({ checkoutSessions: fdB }) { fdB.expireFD2('cs_1'); });
}
// Positive: stored promise, async function expression, multiple statements.
export function fdStored() {
  return pvClients.then(async function ({ stripeClient: fdC }) {
    fdC.transfers.reverseFD3({});
    fdC.charges.captureFD4('ch_1');
  });
}
// Negative: default value in the pattern is not a pure member pick.
export function fdDefVal() {
  return pvClients.then(function ({ stripeClient: fdE = null }) { fdE.charges.captureFD5('x'); });
}
// Negative: ghost key never binds.
export function fdGhost() {
  return import('./lib/clientmod.mjs').then(function ({ nopeHere: fdF }) { fdF.charges.captureFD6('x'); });
}
// Negative: reassignment inside the body drops that local.
export function fdReassign() {
  return pvClients.then(function ({ stripeClient: fdG }) { fdG = {}; fdG.charges.captureFD7('x'); });
}
// Negative: nested function in the body drops the whole body.
export function fdNested() {
  return import('./lib/clientmod.mjs').then(function ({ stripeClient: fdH }) { [1].map(function (fdH) { return fdH; }); fdH.charges.captureFD8('x'); });
}

// --- `.finally()` interposed before `.then` (Loop 252):
// `import('./rel').finally(cb).then(...)` / `pv.finally(cb).then(...)` —
// `.finally` passes the resolution value through untouched (its callback
// receives no argument), so the downstream `.then` param carries the exact
// same module-namespace proof. The finally argument is bounded to a single
// line with at most one paren nesting level; anything wilder is an honest
// miss. Chains rooted inside the finally callback itself never bind. ---
// Positive: inline import, finally then plain param.
export function fnInline() {
  return import('./lib/clientmod.mjs').finally(cleanupFN).then((m) => m.stripeClient.topups.createFN1({}));
}
// Positive: inline import, finally then destructured alias key carries prefix.
export function fnDestr() {
  return import('./lib/clientmod.mjs').finally(() => releaseFN()).then(({ checkoutSessions: fnB }) => fnB.expireFN2('cs_1'));
}
// Positive: stored promise, finally then block body.
export function fnStored() {
  return pvClients.finally(cleanupFN).then((m) => { m.stripeClient.transfers.reverseFN3({}); });
}
// Positive: stored promise, finally then function-expression destructured param.
export function fnStoredFx() {
  return pvClients.finally(releaseFN).then(function ({ stripeClient: fnD }) { fnD.charges.captureFN4('ch_1'); });
}
function cleanupFN() {}
function releaseFN() {}
// Negative: chain inside the finally callback itself never binds (no value).
export function fnBad() {
  return import('./lib/clientmod.mjs').finally((m) => m.stripeClient.charges.captureFN5('x'));
}
// Negative: `.catch` interposed is not value-preserving in the same way — silent.
export function fnCatch() {
  return import('./lib/clientmod.mjs').catch((e) => null).then((m) => m.stripeClient.charges.captureFN6('x'));
}

// --- `Promise.allSettled` positional destructure (Loop 253):
// `const [ra, rb] = await Promise.allSettled([...]);` — same positional
// alignment proof as Promise.all, but each bound local is a settled RESULT
// OBJECT: the module namespace sits under `.value` only (fulfilled entries).
// Chains must therefore start with exactly `.value`; `.status`, `.reason`,
// or direct member access on the result object never bind. ---
// Positive: inline imports, both positions bind through .value.
export async function qsInline() {
  const [qra, qrb] = await Promise.allSettled([import('./lib/clientmod.mjs'), import('./lib/clientmod.mjs')]);
  qra.value.stripeClient.transfers.reverseQS1({});
  qrb.value.checkoutSessions.expireQS2('cs_1'); // alias prefix travels under value
}
// Positive: stored proven promise variable element.
export async function qsStored() {
  const [qrc] = await Promise.allSettled([pvClients]);
  qrc.value.stripeClient.charges.captureQS3('ch_1');
}
// Negative: direct member access without .value never binds.
export async function qsDirect() {
  const [qrd] = await Promise.allSettled([import('./lib/clientmod.mjs')]);
  qrd.stripeClient.charges.captureQS4('x');
}
// Negative: `.value` on a plain Promise.all binding is a ghost head.
export async function qsAllValue() {
  const [qme] = await Promise.all([import('./lib/clientmod.mjs')]);
  qme.value.stripeClient.charges.captureQS5('x');
}
// Negative: non-provable expression element drops the whole statement.
export async function qsExpr() {
  const [qrf] = await Promise.allSettled([pvClients, Math.random()]);
  qrf.value.stripeClient.charges.captureQS6('x');
}

// --- `Promise.race` / `Promise.any` single-value binding (Loop 254):
// race/any resolve to ONE element's value. When every array element is a
// literal relative import() of the SAME target file, the winner is that
// file's module namespace no matter which element settles first — plain
// table dispatch, identical proof to `const m = await import('./rel')`.
// Divergent targets, non-import elements, holes, and bare packages drop
// the whole statement. ---
// Positive: race over same-target imports binds the namespace (with slots).
export async function qcRace() {
  const qca = await Promise.race([import('./lib/clientmod.mjs'), import('./lib/clientmod.mjs')]);
  qca.stripeClient.transfers.reverseQC1({});
}
// Positive: any over same-target imports, alias prefix travels.
export async function qcAny() {
  const qcb = await Promise.any([import('./lib/clientmod.mjs'), import('./lib/clientmod.mjs')]);
  qcb.checkoutSessions.expireQC2('cs_1');
}
// Positive: single-element race (degenerate but valid same-target proof).
export async function qcOne() {
  const qcc = await Promise.race([import('./lib/clientmod.mjs')]);
  qcc.stripeClient.charges.captureQC3('ch_1');
}
// Negative: divergent targets — winner unknown, never bind.
export async function qcMixed() {
  const qcd = await Promise.race([import('./lib/clientmod.mjs'), import('./lib/barrel.mjs')]);
  qcd.stripeClient.charges.captureQC4('x');
}
// Negative: non-import expression element drops the whole statement.
export async function qcExpr() {
  const qce = await Promise.any([import('./lib/clientmod.mjs'), Promise.resolve(1)]);
  qce.stripeClient.payouts.cancelQC5('x');
}
// Negative: hole element (undefined settles race with a non-namespace value).
export async function qcHole() {
  const qcf = await Promise.race([, import('./lib/clientmod.mjs')]);
  qcf.stripeClient.charges.captureQC6('x');
}

// --- Stored proven promise variables inside `Promise.race` / `Promise.any`
// (Loop 255): same single-value proof as the inline form, but elements may
// be guard-surviving promise variables, mixed with literal imports. All
// elements must resolve to the SAME target file; divergent targets,
// non-provable elements, and reassigned variables drop the whole
// statement. All-inline statements stay in DYN_RACE_RE territory. ---
// Positive: stored + inline mixed race, same target binds namespace.
export async function srMixed() {
  const sra = await Promise.race([pvClients, import('./lib/clientmod.mjs')]);
  sra.stripeClient.transfers.reverseSR1({});
}
// Positive: any over two stored proven vars, alias prefix travels.
const pvClientsB = import('./lib/clientmod.mjs');
export async function srAny() {
  const srb = await Promise.any([pvClients, pvClientsB]);
  srb.checkoutSessions.expireSR2('cs_1');
}
// Positive: single stored element race (degenerate but valid).
export async function srOne() {
  const src = await Promise.race([pvClients]);
  src.stripeClient.charges.captureSR3('ch_1');
}
// Negative: divergent targets (stored var vs different-file import).
export async function srDivergent() {
  const srd = await Promise.race([pvClients, import('./lib/barrel.mjs')]);
  srd.stripeClient.charges.captureSR4('x');
}
// Negative: non-provable expression element drops the whole statement.
export async function srExpr() {
  const sre = await Promise.any([pvClients, Promise.resolve(1)]);
  sre.stripeClient.payouts.cancelSR5('x');
}
// Negative: unproven (reassigned) promise variable element.
let pvReassignedSR = import('./lib/clientmod.mjs');
pvReassignedSR = null;
export async function srReassigned() {
  const srf = await Promise.race([pvReassignedSR, import('./lib/clientmod.mjs')]);
  srf.stripeClient.charges.captureSR6('x');
}

// --- nsRoots family unified identity guards (Loop 256): every dynamic-import
// namespace binding proves what the variable holds AT DECLARATION only — a
// later reassignment, catch binding, or for-head capture destroys that
// identity file-wide and the name must never bind. Previously only the
// promiseVars family carried these guards; the nsRoots family (DYN_NS/
// DYN_PROP/DYN_DESTR/DYN_ALL/DYN_RACE) had othersDeclare alone. ---
// Negative: plain namespace binding reassigned after declaration.
let rgNs = await import('./lib/clientmod.mjs');
rgNs = globalThis.somethingElse;
export function rgNsUse() {
  rgNs.stripeClient.charges.captureRG1('x');
}
// Negative: head-selection binding reassigned after declaration.
let rgProp = (await import('./lib/clientmod.mjs')).stripeClient;
rgProp = globalThis.other;
export function rgPropUse() {
  rgProp.invoices.payRG2('in_1');
}
// Negative: destructured local reassigned after declaration.
let { stripeClient: rgDes } = await import('./lib/clientmod.mjs');
rgDes = globalThis.other;
export function rgDesUse() {
  rgDes.customers.createRG3({});
}
// Negative: catch binding captures the namespace name in an inner scope.
const rgCatch = await import('./lib/clientmod.mjs');
export function rgCatchUse() {
  try { globalThis.x(); } catch (rgCatch) { console.log(rgCatch); }
  rgCatch.stripeClient.tokens.createRG4({});
}
// Negative: for-head capture of a Promise.all positional binding.
const [rgFor] = await Promise.all([import('./lib/clientmod.mjs')]);
export function rgForUse() {
  for (const rgFor of []) console.log(rgFor);
  rgFor.stripeClient.plans.listRG5({});
}
// Negative: race single-value binding reassigned after declaration.
let rgRace = await Promise.race([import('./lib/clientmod.mjs'), import('./lib/clientmod.mjs')]);
rgRace = globalThis.other;
export function rgRaceUse() {
  rgRace.stripeClient.charges.captureRG6('x');
}
// Positive control: untouched binding still binds; a compound assignment on
// an UNRELATED name and a string lookalike must not trip the guard.
const rgOk = await import('./lib/clientmod.mjs');
let rgCounter = 0;
rgCounter += 2;
const rgLook = "rgOk = fake";
export function rgOkUse() {
  console.log(rgCounter, rgLook);
  rgOk.stripeClient.coupons.createRG7({});
}

// --- Loop 257: allSettled settled-result nested destructure (`{ value }` /
// `{ value: local }` pattern element picks the namespace inline — no wrap,
// the local IS the namespace). Only the exact single-key value pick binds;
// defaults, extra keys, deeper nesting, and picks on plain Promise.all drop.
// Positive: aliased pick, single element.
export async function qvOne() {
  const [{ value: qvA }] = await Promise.allSettled([import('./lib/clientmod.mjs')]);
  qvA.stripeClient.charges.captureQV1('ch_1');
}
// Positive: mixed plain binding + aliased pick in one statement; the plain
// binding keeps wrap:'value' semantics, the pick is unwrapped.
export async function qvMixed() {
  const [qvPlain, { value: qvB }] = await Promise.allSettled([import('./lib/clientmod.mjs'), import('./lib/clientmod.mjs')]);
  qvPlain.value.stripeClient.payouts.cancelQV2('po_1');
  qvB.checkoutSessions.expireQV3('cs_1');
}
// Positive: shorthand pick binds under the name `value`.
export async function qvShort() {
  const [{ value }] = await Promise.allSettled([import('./lib/clientmod.mjs')]);
  value.stripeClient.transfers.createQV4({});
}
// Negative: default value makes the pick impure.
export async function qvDefault() {
  const [{ value: qvD = null }] = await Promise.allSettled([import('./lib/clientmod.mjs')]);
  qvD.stripeClient.charges.captureQV5('x');
}
// Negative: extra key (status) alongside value — impure pick.
export async function qvStatus() {
  const [{ status: qvS, value: qvE }] = await Promise.allSettled([import('./lib/clientmod.mjs')]);
  qvE.stripeClient.charges.captureQV6(qvS);
}
// Negative: nested pick on plain Promise.all — element is the namespace
// itself, `{ value: x }` is not a settled-result pick there.
export async function qvPlainAll() {
  const [{ value: qvF }] = await Promise.all([import('./lib/clientmod.mjs')]);
  qvF.stripeClient.charges.captureQV7('x');
}
// Negative: deeper nesting inside the pick.
export async function qvDeep() {
  const [{ value: { stripeClient: qvG } }] = await Promise.allSettled([import('./lib/clientmod.mjs')]);
  qvG.charges.captureQV8('x');
}
// Negative: picked local reassigned after declaration (identity guard).
export async function qvReassign() {
  let [{ value: qvH }] = await Promise.allSettled([import('./lib/clientmod.mjs')]);
  qvH = globalThis.other;
  qvH.stripeClient.charges.captureQV9('x');
}

// --- Loop 258: settled-value pick on STORED/MIXED Promise.allSettled elements
// (stored twin of the Loop 257 inline form — pattern element `{ value: local }`
// unwraps the settled result inline, the local IS the namespace). Only the
// exact single-key value pick binds; defaults, extra keys, deeper nesting,
// picks on plain Promise.all, and reassigned locals drop.
// Positive: aliased pick over a stored proven promise variable.
export async function svOne() {
  const [{ value: svA }] = await Promise.allSettled([pvClients]);
  svA.stripeClient.charges.captureSV1('ch_1');
}
// Positive: mixed stored + inline elements, plain binding + aliased pick in
// one statement; the plain binding keeps wrap:'value', the pick is unwrapped.
export async function svMixed() {
  const [svPlain, { value: svB }] = await Promise.allSettled([pvClients, import('./lib/clientmod.mjs')]);
  svPlain.value.stripeClient.payouts.cancelSV2('po_1');
  svB.checkoutSessions.expireSV3('cs_1');
}
// Negative: default value makes the pick impure.
export async function svDefault() {
  const [{ value: svD = null }] = await Promise.allSettled([pvClients]);
  svD.stripeClient.charges.captureSV4('x');
}
// Negative: pick on plain Promise.all over a stored element — the element is
// the namespace itself there, `{ value: x }` would be an export pick.
export async function svPlainAll() {
  const [{ value: svF }] = await Promise.all([pvClients]);
  svF.stripeClient.charges.captureSV5('x');
}
// Negative: picked local reassigned after declaration (identity guard).
export async function svReassign() {
  let [{ value: svH }] = await Promise.allSettled([pvClients]);
  svH = globalThis.other;
  svH.stripeClient.charges.captureSV6('x');
}

// --- Loop 259: MULTI-LINE `.finally()` callback interposed before `.then`
// (Loop 252 covered single-line finally args only; a line break inside the
// callback body blinded the whole `.then` family). The finally segment now
// spans lines but still allows at most one paren-nesting level — the value
// pass-through proof is unchanged.
// Positive: inline plain param, multi-line finally arrow body.
export function mfInline() {
  return import('./lib/clientmod.mjs').finally(() => {
    releaseMF();
  }).then((m) => m.stripeClient.transfers.reverseMF1({}));
}
// Positive: inline destructured param, multi-line finally.
export function mfInlineDestr() {
  return import('./lib/clientmod.mjs').finally(() => {
    releaseMF();
  }).then(({ checkoutSessions: mfB }) => mfB.expireMF2('cs_1'));
}
// Positive: stored promise, multi-line finally, block body.
export function mfStored() {
  return pvClients.finally(() => {
    releaseMF();
  }).then((m) => { m.stripeClient.charges.captureMF3('ch_1'); });
}
// Positive: stored promise, multi-line finally, function-expr destructured.
export function mfStoredFn() {
  return pvClients.finally(() => {
    releaseMF();
  }).then(function ({ stripeClient: mfD }) { mfD.payouts.cancelMF4('po_1'); });
}
// Negative: chain lives INSIDE the multi-line finally callback (finally
// callbacks receive no value — never bind).
export function mfNegInside() {
  return import('./lib/clientmod.mjs').finally((m) => {
    m.stripeClient.charges.captureMF5('x');
  });
}
// Negative: multi-line `.catch` interposed — catch is not value-transparent.
export function mfNegCatch() {
  return import('./lib/clientmod.mjs').catch((e) => {
    return null;
  }).then((m) => m.stripeClient.charges.captureMF6('x'));
}
function releaseMF() {}

// --- Loop 260: DEPTH-2 paren nesting inside the `.finally()` callback arg
// (Loop 252/259 allowed one nesting level only; `finally(() => stop(timer(id)))`
// — a call wrapped in a call inside the arrow — blinded the `.then` family).
// The finally segment now admits two nesting levels; depth-3 stays an honest
// miss. Value pass-through proof unchanged.
// Positive: inline plain param, depth-2 finally arg.
export function dfInline() {
  return import('./lib/clientmod.mjs').finally(() => stopDF(timerDF(1))).then((m) => m.stripeClient.transfers.reverseDF1({}));
}
// Positive: inline destructured param, depth-2 finally arg.
export function dfInlineDestr() {
  return import('./lib/clientmod.mjs').finally(() => logDF(fmtDF(2))).then(({ checkoutSessions: dfB }) => dfB.expireDF2('cs_1'));
}
// Positive: stored promise, depth-2 finally, block body.
export function dfStored() {
  return pvClients.finally(() => trackDF(evtDF(3))).then((m) => { m.stripeClient.charges.captureDF3('ch_1'); });
}
// Positive: stored promise, multi-line depth-2 finally, function-expr destructured.
export function dfStoredFn() {
  return pvClients.finally(() => {
    releaseDF(lockDF(4));
  }).then(function ({ stripeClient: dfD }) { dfD.payouts.cancelDF4('po_1'); });
}
// --- Loop 266: DEPTH-3 paren nesting inside the `.finally()` callback arg
// (Loop 260 stopped at two levels; `finally(() => stop(timer(tick(id))))` —
// helper-wrapped telemetry/cleanup three calls deep — blinded the `.then`
// family again). The finally segment now admits three nesting levels;
// depth-4 stays an honest miss. Value pass-through proof unchanged.
// Positive (was the Loop 260 negative): depth-3 finally arg now binds.
export function dfDeep3() {
  return import('./lib/clientmod.mjs').finally(() => a(b(c(d)))).then((m) => m.stripeClient.charges.captureDF5('x'));
}
// Positive: stored promise, depth-3 finally, block body.
export function gfStored() {
  return pvClients.finally(() => trackDF(evtDF(wrapGF(3)))).then((m) => { m.stripeClient.balance.retrieveGF2(); });
}
// Negative: depth-4 finally arg — honest miss, never binds.
export function gfNegDeep() {
  return import('./lib/clientmod.mjs').finally(() => a(b(c(d(e))))).then((m) => m.stripeClient.charges.captureGF1('x'));
}
// Negative: chain lives INSIDE a depth-3 finally callback (no value — never bind).
export function gfNegInside() {
  return import('./lib/clientmod.mjs').finally((m) => { m.stripeClient.charges.captureGF3(x(y(z(w)))); });
}
// Negative: chain lives INSIDE a depth-2 finally callback (no value — never bind).
export function dfNegInside() {
  return import('./lib/clientmod.mjs').finally((m) => { m.stripeClient.charges.captureDF6(x(y(z))); });
}
function stopDF() {} function timerDF() {} function logDF() {} function fmtDF() {}
function trackDF() {} function evtDF() {} function releaseDF() {} function lockDF() {}
function wrapGF() {}
