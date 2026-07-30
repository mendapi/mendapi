// Loop 206: TS typed class fields — the TS mirror of the PHP typed-property
// proof. The declared type (field declaration or constructor parameter
// property) is the binding proof: tsc enforces it at compile time.
// Positives bind; unions, cross-provider conflicts, multi-line ctor
// signatures, unmodified params, and lookalikes stay silent.
import Stripe from 'stripe';

// positive: typed field declaration + ctor assignment consumption
export class DeclService {
  private readonly sc: Stripe;
  constructor(sc: Stripe) { this.sc = sc; }
  pay(a: object) { return this.sc.paymentIntents.confirmTF1(a); }
}

// positive: constructor parameter property (single-line signature)
export class ParamService {
  constructor(private readonly stripe: Stripe) {}
  bill(a: object) { return this.stripe.invoices.finalizeTF2(a); }
}

// positive: optional-modifier typed field (`?` — the declared type is still
// the binding)
export class OptService {
  sc?: Stripe;
  refund(a: object) { return this.sc.setupIntents.createTF3(a); }
}

// negative: union type is honestly not bound (never guess)
export class UnionService {
  maybe: Stripe | null;
  bad(a: object) { return this.maybe.charges.createTF4(a); }
}

// positive since Loop 221: multi-line ctor parameter property binds (the
// balanced-paren walk collects the wrapped signature; Prettier's default
// one-param-per-line spelling). Negative before Loop 221.
export class MultiLineService {
  constructor(
    private readonly ml: Stripe,
  ) {}
  pay(a: object) { return this.ml.disputes.closeTF5(a); }
}

// negative: ctor param without an access modifier is not a class field
export class PlainParamService {
  constructor(plain: Stripe) { void plain; }
  bad(a: object) { return (this as any).plain.transfers.createTF6(a); }
}

// negative: comment / string lookalikes never bind
// private ghost: Stripe;
const note = 'private ghost2: Stripe;';
export function ghostTF(o: { ghost2: any }) {
  void note;
  return o.ghost2.payouts.cancelTF7(1);
}

// Loop 215 negatives: interface / type-literal / ambient members are shape
// declarations, never class-field proofs — `this.<member>` chains in other
// classes must stay silent.
export interface HolderIF {
  scIF: Stripe;
}
class ImplIF {
  bad(a: object) { return this.scIF.charges.createIF8(a); }
}

type ShapeTL = {
  scTL: Stripe;
};
class ImplTL {
  bad(a: object) { return this.scTL.charges.createTL8(a); }
}

declare class AmbientDC {
  scDC: Stripe;
}
class ImplDC {
  bad(a: object) { return this.scDC.charges.createDC8(a); }
}
void (0 as unknown as HolderIF); void (0 as unknown as ShapeTL); void AmbientDC;

// Loop 215 positive control: a real class field declared AFTER the
// interface blocks above still binds (span walk must not overshoot).
export class AfterSpansService {
  private readonly scAS: Stripe;
  constructor(scAS: Stripe) { this.scAS = scAS; }
  pay(a: object) { return this.scAS.subscriptions.resumeAS1(a); }
}

// Loop 216 negatives: inline type-literal contexts (annotation position and
// `as` assertions) declare shapes, never class fields — `this.<member>`
// chains in other classes must stay silent.
export function takeShape(o: {
  scIL: Stripe;
}) { return o; }
class ImplIL {
  bad(a: object) { return this.scIL.charges.createIL9(a); }
}

const castIL = {} as {
  scIL2: Stripe;
};
class ImplIL2 {
  bad(a: object) { return this.scIL2.invoices.retrieveIL9(a); }
}
void ImplIL; void ImplIL2; void castIL;

// Loop 216 positive control: a real class field after the inline literals
// still binds (span walk must not overshoot).
export class AfterInlineService {
  private readonly scAI: Stripe;
  constructor(scAI: Stripe) { this.scAI = scAI; }
  pay(a: object) { return this.scAI.payouts.cancelAI1(a); }
}

// Loop 217 negatives: `extends` type-literal contexts (generic constraints)
// declare shapes, never class fields — `this.<member>` chains in other
// classes must stay silent.
export function pickGC<T extends {
  scGC: Stripe;
}>(x: T) { return x; }
class ImplGC {
  bad(a: object) { return this.scGC.charges.confirmGC1(a); }
}
const grabGC = <U extends {
  scGC2: Stripe;
}>(u: U) => u;
class ImplGC2 {
  bad(a: object) { return this.scGC2.invoices.retrieveGC2(a); }
}
void ImplGC; void ImplGC2; void grabGC;

// Loop 217 positive control: a real class field after the extends literals
// still binds (span walk must not overshoot).
export class AfterExtendsService {
  private readonly scAX: Stripe;
  constructor(scAX: Stripe) { this.scAX = scAX; }
  pay(a: object) { return this.scAX.subscriptions.cancelAX1(a); }
}

// Loop 218 negatives: multi-line openers — `type X =` / Allman-style
// `interface X` with the brace on the next line declare shapes, never class
// fields; `this.<member>` chains in other classes must stay silent.
export type WideML =
{
  scML: Stripe;
};
class ImplML {
  bad(a: object) { return this.scML.customers.confirmML1(a); }
}
interface AllmanML
{
  scML2: Stripe;
}
class ImplML2 {
  bad(a: object) { return this.scML2.invoices.retrieveML2(a); }
}
void ImplML; void ImplML2; void (0 as unknown as WideML); void (0 as unknown as AllmanML);

// Loop 218 positive control: a real class field after the multi-line
// openers still binds (span walk must not overshoot).
export class AfterMultilineService {
  private readonly scAY: Stripe;
  constructor(scAY: Stripe) { this.scAY = scAY; }
  pay(a: object) { return this.scAY.subscriptions.cancelAY1(a); }
}

// Loop 219 negatives: openers separated from their brace by comment lines
// (`type X =` + `// note` + `{`, Allman interface with a block-comment line)
// declare shapes, never class fields; `this.<member>` chains in other
// classes must stay silent.
export type WideCG =
// prettier keeps this note before the brace
{
  scCG: Stripe;
};
class ImplCG {
  bad(a: object) { return this.scCG.customers.confirmCG1(a); }
}
interface AllmanCG
/* holder shape */
{
  scCG2: Stripe;
}
class ImplCG2 {
  bad(a: object) { return this.scCG2.invoices.retrieveCG2(a); }
}
void ImplCG; void ImplCG2; void (0 as unknown as WideCG); void (0 as unknown as AllmanCG);

// Loop 219 positive control: a real class field after the comment-gap
// openers still binds (span walk must not overshoot).
export class AfterCommentGapService {
  private readonly scAZ: Stripe;
  constructor(scAZ: Stripe) { this.scAZ = scAZ; }
  pay(a: object) { return this.scAZ.subscriptions.cancelAZ1(a); }
}

// Loop 220 positive: single-line class body — a typed field declared after
// the `{`/`;` statement-boundary token on one line is the same declaration
// proof (object literals separate entries with commas, so `ident: Type;`
// can never be a value-position entry).
export class OneLineService { scSB: Stripe; pay(a: object) { return this.scSB.subscriptions.cancelSB1(a); } }

// Loop 220 negatives: single-line interface members, commented and in-string
// lookalikes never mint a binding.
interface OneLineHolder { scSB2: Stripe; }
class ImplSB2 { bad(a: object) { return this.scSB2.customers.confirmSB2(a); } }
// class GhostSB { scSB3: Stripe; }
class ImplSB3 { bad(a: object) { return this.scSB3.invoices.retrieveSB3(a); } }
const noteSB = 'class GhostSB4 { scSB4: Stripe; }';
class ImplSB4 { bad(a: object) { return this.scSB4.disputes.closeSB4(a); } }
void ImplSB2; void ImplSB3; void ImplSB4; void noteSB; void (0 as unknown as OneLineHolder);

// Loop 232 positives: class property INITIALIZER construction — the
// declare-and-construct one-liner (modifier required; optional annotation).
export class InitFieldService {
  private stripeFI = new Stripe('k');
  pay(a: object) { return this.stripeFI.paymentIntents.confirmFI1(a); }
}
export class InitAnnotatedService {
  private readonly scFI: Stripe = new Stripe('k');
  bill(a: object) { return this.scFI.invoices.finalizeFI2(a); }
}

// Loop 232 negatives: commented / in-string initializer lookalikes,
// modifier-less initializer (honest AST-track skip), reused field name
// initialized elsewhere from a non-proven RHS, and a later this-assignment
// re-write — none may mint a binding.
class InitNegService {
  // private scFI3 = new Stripe('k');
  bad(a: object) { return (this as any).scFI3.customers.confirmFI3(a); }
}
const noteFI = "private scFI4 = new Stripe('k');";
class InitNegStr { bad(a: object) { void noteFI; return (this as any).scFI4.disputes.closeFI4(a); } }
class InitNegPlain {
  scFI5 = new Stripe('k');
  bad(a: object) { return this.scFI5.transfers.reverseFI5(a); }
}
class InitNegReuseA {
  private scFI6 = new Stripe('k');
  use(a: object) { return this.scFI6.payouts.cancelFI6(a); }
}
class InitNegReuseB {
  private scFI6 = ghostFI();
}
declare function ghostFI(): unknown;
class InitNegRewrite {
  private scFI7 = new Stripe('k');
  reset() { this.scFI7 = null as never; }
  bad(a: object) { return this.scFI7.setupIntents.createFI7(a); }
}
void InitNegService; void InitNegStr; void InitNegPlain; void InitNegReuseA; void InitNegReuseB; void InitNegRewrite;

// Loop 221 positive: multi-line ctor with several wrapped param properties
// (Prettier/NestJS default spelling) binds the provider-typed one.
export class WrappedCtorService {
  constructor(
    private readonly logMC: Console,
    private readonly scMC: Stripe,
  ) {}
  pay(a: object) { return this.scMC.paymentIntents.captureMC1(a); }
}

// Loop 221 negatives: inside a multi-line ctor signature — a commented-out
// param property, a string-default lookalike, and an inline type-literal
// member never mint a binding; a plain (modifier-less) param stays silent.
class WrappedNegService {
  constructor(
    // private readonly scMC2: Stripe,
    private readonly noteMC: string = 'private readonly scMC3: Stripe,',
    private readonly cfgMC: { scMC4: Stripe; verbose: boolean },
    scMC5: Stripe,
  ) { void scMC5; }
  bad(a: object) {
    void (this as any).scMC2.customers.confirmMC2(a);
    void (this as any).scMC3.invoices.retrieveMC3(a);
    void (this as any).scMC4.disputes.closeMC4(a);
    return (this as any).scMC5.transfers.reverseMC5(a);
  }
}
void WrappedNegService;

// Loop 236 negative: a provider-typed member inside a generic DEFAULT type
// literal (`<T = { ... }>`) is a TYPE, never a class field — the previously
// untracked Loop 220 limitation, now span-guarded (`=` opener). The chain
// below must stay silent.
class GenDefaultNeg<T = { scGD1: Stripe; extra: number }> {
  hold(v: T) { return v; }
}
class GenDefaultChain {
  scGD1: any;
  bad(a: object) { return this.scGD1.payouts.reverseGD1(a); }
}
void GenDefaultNeg; void GenDefaultChain;

// Loop 236 positive: a real class field declared AFTER a generic-default
// type literal still binds — the span guard closes at the literal's `}`
// and never swallows the class body that follows.
export class GenDefaultAfter<T = { other6: Stripe }> {
  scGD2: Stripe;
  constructor() { this.scGD2 = new Stripe('k'); }
  pay(a: object) { return this.scGD2.payouts.confirmGD2(a); }
}

