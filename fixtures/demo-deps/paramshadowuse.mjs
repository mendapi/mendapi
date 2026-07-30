// nsRoots param-shadow identity guard (Loop 263): an arrow/function
// parameter that reuses a dynamic-import binding name rebinds it in that
// inner scope — chains anywhere in the file are then unattributable
// without scope tracking, so the binding is dropped file-wide (false
// drops are safe; false binds are not). Real parameter positions only:
// passing the binding as a plain call argument never trips the guard.

// Negative: bare arrow param shadows the namespace binding.
const psA = await import('./lib/clientmod.mjs');
export const psRowsA = [1].map(psA => psA.stripeClient.charges.listPG1({ limit: psA }));

// Negative: paren-list arrow param shadows the binding.
const psB = await import('./lib/clientmod.mjs');
export const psRowsB = [1].map((x, psB) => psB.stripeClient.refunds.createPG2({ charge: x }));

// Negative: function-declaration param shadows the binding.
const psC = await import('./lib/clientmod.mjs');
export function pickPS(psC) { return psC.stripeClient.payouts.cancelPG3('po_1'); }

// Negative: Promise.all positional binding shadowed by a function param.
const [psD] = await Promise.all([import('./lib/clientmod.mjs')]);
export function usePS(psD) { return psD.stripeClient.topups.createPG4({}); }

// Positive: untouched binding binds even when passed as a plain call
// argument and mentioned in strings/comments — argument position is not a
// parameter position.
const psE = await import('./lib/clientmod.mjs');
registerPS(psE); // hand psE to a helper — never a shadow
// prose: (psE) => lookalike inside a comment must not trip the guard
export function goPS() { return psE.stripeClient.coupons.createPG5('c_1'); }
function registerPS() {}

// Loop 264: balanced param-list walk — call-expression defaults nest
// parens INSIDE the list, which the old flat regex could not cross.

// Negative: shadow param AFTER a call-expression default drops the binding.
const psF = await import('./lib/clientmod.mjs');
export const psRowsF = [1].map((other = mkPS(), psF) => psF.stripeClient.charges.listPG6({ limit: 1 }));

// Negative: same shape in a function declaration param list.
const psG = await import('./lib/clientmod.mjs');
export function pickPSG(other = mkPS(1, 2), psG) { return psG.stripeClient.refunds.createPG7({}); }

// Positive: binding used as an ARGUMENT inside a call-expression default
// is argument position, not parameter position — must still bind.
const psH = await import('./lib/clientmod.mjs');
export const psRowsH = [1].map((cfg = wrapPS(psH), x) => cfg + x);
export const psUseH = psH.stripeClient.payouts.cancelPG8('po_1');

// Positive: binding inside an if-condition paren is not a param list.
const psI = await import('./lib/clientmod.mjs');
if (checkPS(psI)) { /* no-op */ }
export const psUseI = psI.stripeClient.topups.createPG9({});

function mkPS() { return null; }
function wrapPS(x) { return x; }
function checkPS() { return false; }

// Loop 265: grammar-shaped function-header lookbehind — formatters break
// long function names across lines, putting the `(` of the param list on
// its own line. The old same-line lookbehind missed those headers.

// Negative: function name and param list on different lines; shadow param
// in the list drops the binding.
const psJ = await import('./lib/clientmod.mjs');
export const psFnJ = function veryLongWrappedHelperNamePS
(other, psJ) { return psJ.stripeClient.charges.listPG10({ limit: 1 }); };

// Negative: anonymous function expression, `function` keyword alone on its
// line, list on the next — same drop.
const psK = await import('./lib/clientmod.mjs');
export const psFnK = function
(psK) { return psK.stripeClient.refunds.createPG11({}); };

// Positive: a CALL whose `(` opens on the next line is not a function
// header — passing the binding there is argument position and must bind.
const psL = await import('./lib/clientmod.mjs');
registerPS
(psL);
export const psUseL = psL.stripeClient.payouts.cancelPG12('po_1');
