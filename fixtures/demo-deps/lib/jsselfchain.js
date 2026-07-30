// Chained-assignment this-field binding fixture (Loop 359).
//
// JS assignment is an expression: a chained assignment with a this-field
// target binds EVERY target to the same constructed client (Loop 349
// semantics composed with the this-field proof, mirroring the Python
// Loop 358 and PHP Loop 352 verdicts). Field-first, var-first and
// field-to-field two-target forms bind; derived trailers, 3+ targets and
// prose lookalikes stay silent.
const Stripe = require('stripe');

class FieldFirstQT {
  constructor(key) {
    // QT1/QT2 (positive): field-first chained — field AND var both consume.
    this.sc_qt = qtClientA = new Stripe(key);
    this.sc_qt.terminal_readers.wakeQT1('tmr_1');
  }
}
let qtClientA;
function useQtA() { qtClientA.card_holders.wakeQT2('ich_1'); }

let qtClientB;
class VarFirstQT {
  constructor(key) {
    // QT3/QT4 (positive): var-first chained — both consume.
    qtClientB = this.sc_qtb = new Stripe(key);
    this.sc_qtb.financial_accounts.wakeQT3('fa_1');
  }
}
function useQtB() { qtClientB.scheduled_queries.wakeQT4('sq_1'); }

class FieldToFieldQT {
  constructor(key) {
    // QT5/QT6 (positive): field-to-field chained — both fields consume.
    this.sc_qtc = this.alias_qtc = new Stripe(key);
    this.sc_qtc.billing_meters.wakeQT5('mtr_1');
    this.alias_qtc.review_items.wakeQT6('rvi_1');
  }
}

class DerivedTrailerQT {
  constructor(key) {
    // QT7 (negative): derived-object trailer after the balanced close —
    // neither name holds the client (Loop 338 verdict carries over).
    this.dv_qt = qtDw = new Stripe(key).charges;
    this.dv_qt.dropQT7('ch_1');
  }
}
let qtDw;

class ThreeTargetsQT {
  constructor(key) {
    // QT8 (negative): 3+ targets are an honest skip (AST track).
    this.a_qt = qtB = qtC = new Stripe(key);
    this.a_qt.dropQT8('x_1');
  }
}
let qtB, qtC;

// QT9 (negative): a chained this-field assignment quoted in a template
// literal must never mint a field or an instance.
const qtUsage = `
example:
  this.sx_qt = qtCx = new Stripe(key);
  this.sx_qt.forwarding.dropQT9('fr_1');
`;

module.exports = { FieldFirstQT, VarFirstQT, FieldToFieldQT, DerivedTrailerQT, ThreeTargetsQT, useQtA, useQtB, qtUsage };
