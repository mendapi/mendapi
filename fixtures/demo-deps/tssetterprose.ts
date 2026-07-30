// Loop 307: prose guards on the setter hand-off matcher — the hand-off
// pattern (`this.f = p;`) is not line-anchored, so before this loop a
// comment- or string-quoted lookalike of the hand-off minted a phantom
// field and every same-file `this.f.` chain was mis-attributed to the SDK.
// Positives bind; comment/string/template lookalikes stay silent.
import Stripe from 'stripe';

// positive control: real hand-off still binds
export class ProseCtlSvc {
  private pc: any;
  setClient(pc: Stripe): void { this.pc = pc; }
  run(a: object) { return this.pc.invoiceItems.holdSP1(a); }
}

// negative: hand-off quoted in a line comment never mints a field —
// the setter body is a no-op, so the field is never proven
export class CommentQuoteSvc {
  private cq: any;
  setClient(cq: Stripe): void { void cq; }
  // migration note: older builds assigned `this.cq = cq;` here
  bad(a: object) { return this.cq.creditNotes.markSP2(a); }
}

// negative: hand-off quoted in a string literal never mints a field
export class StringQuoteSvc {
  private sq: any;
  setClient(sq: Stripe): void { void sq; }
  note() { return 'legacy form: this.sq = sq; (removed in v2)'; }
  bad(a: object) { return this.sq.taxRates.pingSP3(a); }
}

// negative: hand-off quoted in a template-literal body (multi-line prose
// container) never mints a field
export class TemplateQuoteSvc {
  private tq: any;
  setClient(tq: Stripe): void { void tq; }
  doc() {
    return `
      upgrade guide: replace the injected client, e.g.
      this.tq = tq;
      then re-run the scanner.
    `;
  }
  bad(a: object) { return this.tq.balanceTransactions.bumpSP4(a); }
}
