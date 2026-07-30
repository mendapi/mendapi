// Loop 275: JS prose masking fixture — block comments (incl. multi-line),
// trailing `//` tails, and quoted string content are prose: chain lookalikes
// inside them must never bind. Template-literal `${}` slots are real code.
const stripe = require('stripe')(process.env.STRIPE_KEY);

/* single-line block: stripe.charges.createJP1({ amount: 100 }) */
const a = stripe.payouts.createJP2({ amount: 5 }); // tail: stripe.coupons.delJP3('c')

/*
 multi-line block comment body
 stripe.topups.createJP4({ amount: 9 })
*/
const b = stripe.credit_notes.createJP5({ charge: 'ch' });

// string content is prose; code on the same line after the close still binds
const doc = "see stripe.balance.retrieveJP6() in the docs"; const c = stripe.disputes.listJP7();

// a `/*` inside a string must never open a phantom block (blackout hazard)
const glob = "/*";
const d = stripe.transfers.createJP8({ amount: 1 });

// template literal: slot expr is real code, surrounding text is prose,
// an escaped \${ stays literal text
const msg = `charged: ${stripe.charges.retrieveJP9(id).amount}`;
const tdoc = `mentions stripe.invoices.createJP10({}) in prose`;
const esc = `escaped \${stripe.plans.createJP11({})} stays literal`;

// Loop 276: MULTI-LINE template literals carry cross-line state — body lines
// are prose, `${}` slots on body lines are real code, and the closing
// backtick must not be misread as an opener (code after it still binds).
const mdoc = `usage example:
  stripe.topups.openMT1({ amount: 1 })
  stripe.coupons.delMT2('x')
`;
const mmsg = `start
charged: ${stripe.charges.retrieveMT3(id).amount}
end`;
const mtail = `prose stripe.balance.retrieveMT4()
more prose`; const mafter = stripe.disputes.listMT5();
const mesc = `body line
escaped \${stripe.plans.openMT6({})} stays literal
`;
const mctl = stripe.transfers.openMT7({ amount: 2 });

// Loop 277: `${}` slots that SPAN LINES are real code by JS grammar — the
// continuation lines must not be masked as template body, nested braces
// keep the slot open, and after the slot closes body masking resumes.
const sdoc = `summary:
${
  stripe.charges.retrieveMS1(id)
}
prose stripe.topups.openMS2({ amount: 3 }) after slot
`;
const sdeep = `report ${ {
  v: stripe.disputes.listMS3()
} } tail`;
const safter = `open ${
  stripe.plans.openMS4({})
}`; const sctl = stripe.transfers.openMS5({ amount: 4 });

// Loop 281: NESTED backticks inside `${}` slots — an inner template is a
// fresh template by JS grammar: its body is prose (must not bind), it may
// carry its own `${}` slots (real code), and after it closes the outer slot
// is code again. The frame stack carries nesting across lines.
const none = `outer ${ fmt(`note: stripe.topups.createNB1({}) documented`) } tail`;
const ntwo = `x ${ join(`label`, stripe.charges.retrieveNB2(id)) } w`;
const nthree = `head ${
  render(`multi
line stripe.coupons.delNB3('x') prose
still body`)
} tail`;
const nfour = `a ${ wrap(`inner ${ stripe.disputes.listNB4() } text`) } b`;
const nfive = stripe.plans.openNB5({ amount: 6 });

// Loop 282: string literals INSIDE `${}` slots — their content is prose and
// their `}` / backtick characters are inert: no early slot close, no phantom
// nested template. Code elsewhere in the slot still binds.
const gone = `v: ${ d.get("k}") + stripe.coupons.retrieveSL1(id) } end`;
const gtwo = `hint: ${ warn("try stripe.plans.delSL2(id) first") } tail`;
const gthree = `m: ${ tag('a`b') + stripe.disputes.markSL3(id) } w`;
const gfour = `e: ${ p("q\"}x") + stripe.topups.putSL4(1) } z`;
const gctl = stripe.transfers.openSL5({ amount: 7 });

// Loop 283: regex literals. A `/` in expression position opens a regex —
// its pattern is prose (lookalike chains inside never bind) and a `/*`
// inside it must never open a phantom block comment (which blacked out the
// rest of the file). A `/` after an operand is division and stays code.
const rone = /stripe\.coupons\.grabRE1\(/;                  // pattern prose — never binds
const rtwo = input.split(/ab\/*cd/); const rafter = stripe.topups.grabRE2({ n: 1 }); // `/*` inert inside regex — binds
const rthree = total / count / 2; const rdiv = stripe.disputes.grabRE3();  // division stays code — binds
if (/stripe\.plans\.grabRE4\(/.test(s)) log(s);              // pattern prose in if-condition — never binds
const rctl = stripe.charges.grabRE5({ amount: 8 });          // state reset — binds

// Loop 284: regex literals INSIDE `${}` slots — slot content is code, so an
// expression-position `/` opens a regex there too: its pattern is prose
// (never binds) and a `/*` inside it never opens a phantom block comment.
// Division inside a slot stays code, and slot code around a regex binds.
const rsone = `m: ${ raw.replace(/stripe.coupons.pokeRS1()/, 'x') } end`;   // slot regex pattern prose — never binds
const rstwo = `q: ${ s.split(/ab\/*cd/).length } t`; const rsafter = stripe.topups.pokeRS2({ n: 2 }); // `/*` in slot regex inert — binds
const rsthree = `r: ${ total / count } u`; const rsdiv = stripe.disputes.pokeRS3();  // division in slot stays code — binds
const rsfour = `multi: ${
  val.replace(/stripe.charges.pokeRS4()/, 'y')
} tail`;                                                     // continuation-line slot regex — never binds
const rsfive = `mix: ${ tag(/x\//) + stripe.plans.pokeRS5({}) } w`;         // slot code after a regex binds

// Loop 287: comments INSIDE `${}` slots — slot content is code, so `//` and
// `/*` open real comments there: their content is prose (lookalike chains
// inside never bind), a `/* */` may span slot lines, and slot code around
// them still binds.
const cone = `r: ${
  // legacy: stripe.coupons.snagCM1(x) was removed
  stripe.charges.retrieveCM2(id)
}`;                                                          // slot // comment prose silent — code on next line binds
const ctwo = `v: ${ fn(/* stripe.topups.snagCM3(y) */) + stripe.plans.openCM4({}) } w`; // inline /* */ in slot silent — code after binds
const cthree = `m: ${ g() /* spans
stripe.disputes.snagCM5(z) still comment prose
*/ + stripe.transfers.markCM6(1) } t`;                        // multi-line /* */ in slot silent — code after closer binds
const cfour = `u: ${ q.split('http://x').length } v`; const cafter = stripe.charges.holdCM7({}); // `//` inside a slot string is NOT a comment — code after template binds
const cctl = stripe.plans.openCM8({ amount: 9 });            // state reset — binds

module.exports = { a, b, c, d, doc, glob, msg, tdoc, esc, mdoc, mmsg, mtail, mafter, mesc, mctl, sdoc, sdeep, safter, sctl, none, ntwo, nthree, nfour, nfive, gone, gtwo, gthree, gfour, gctl, rone, rtwo, rafter, rthree, rdiv, rctl, rsone, rstwo, rsafter, rsthree, rsdiv, rsfour, rsfive, cone, ctwo, cthree, cfour, cafter, cctl };
