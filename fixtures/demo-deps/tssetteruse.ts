// Loop 208: TS setter/method injection — the TS mirror of the PHP
// setter-injection proof (Loop 207). A type-annotated parameter in any
// single-line method signature binds the pure hand-off `this.f = p;`.
// Positives bind; reused param names, param rewrites, cross-provider
// conflicts, multi-line signatures, and lookalikes stay silent.
import Stripe from 'stripe';

// positive: setter injection with return type annotation
export class SetterSvc {
  private sj: any;
  setClient(sj: Stripe): void { this.sj = sj; }
  run(a: object) { return this.sj.paymentLinks.updateSJ1(a); }
}

// negative: same param name reused across two single-line signatures —
// the hand-off attribution is ambiguous (file-level pass, per-method scope)
export class ReusedParamSvc {
  private rp: any;
  setA(rp: Stripe): void { this.rp = rp; }
  setB(rp: number): void { void rp; }
  bad(a: object) { return this.rp.disputes.closeSJ2(a); }
}

// negative: param rewritten before the hand-off — never guess what it holds
export class RewrittenParamSvc {
  private rw: any;
  setC(rw: Stripe): void { rw = null as any; this.rw = rw; }
  bad(a: object) { return this.rw.refunds.listSJ3(a); }
}

// Loop 227 semantic flip: multi-line signatures ARE line-anchored evidence
// now (balanced-paren walk from the line-anchored opener, Loop 221/222
// judgment ported to the setter pass) — this wrapped setter binds.
export class MultiSigSvc {
  private ms: any;
  setD(
    ms: Stripe,
  ): void { this.ms = ms; }
  good(a: object) { return this.ms.topups.retrieveSJ4(a); }
}

// Loop 227 positives: wrapped setter and wrapped plain ctor param (no
// access modifier — handled by the setter pass, not parameter properties)
export class WrappedSetterSvc {
  private sw: any;
  setClient(
    sw: Stripe,
  ): void { this.sw = sw; }
  run(a: object) { return this.sw.paymentLinks.confirmSW1(a); }
}
export class WrappedPlainCtorSvc {
  private pw: any;
  constructor(
    pw: Stripe,
  ) { this.pw = pw; }
  go(a: object) { return this.pw.subscriptions.captureSW2(a); }
}

// Loop 227 negatives: commented lookalike param inside a wrapped signature,
// and a string-default lookalike — both scrubbed, never bind
export class WrappedLookalikeSvc {
  private lk: any;
  setE(
    // ghost: Stripe,
    lk: number,
  ): void { void lk; }
  bad(a: object) { return this.lk.disputes.retrieveSW3(a); }
}
export class WrappedStringDefaultSvc {
  private sd: any;
  setF(
    note: string = 'ghost2: Stripe,',
    sd: number,
  ): void { void note; void sd; }
  bad(a: object) { return this.sd.payouts.reverseSW4(a); }
}

// negative: comment / string lookalikes never bind
// setGhost(gh: Stripe): void { this.gh = gh; }
const noteSJ = 'setGhost2(gh2: Stripe): void { this.gh2 = gh2; }';
export function ghostSJ(o: { gh2: any }) {
  void noteSJ;
  return o.gh2.payouts.cancelSJ5(1);
}
