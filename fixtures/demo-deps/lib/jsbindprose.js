// Loop 286: module-binding matchers must not mint bindings from imports that
// live inside multi-line prose containers (template-literal bodies / block
// comments). Before the guard, the template-body require below bound
// `stripe` file-wide and the lookalike chain minted a false surface.
const USAGE = `
  Setup:
    const stripe = require('stripe');
`;

// BX3: `stripe` was never really required — the only "require" is template
// prose, so this chain must stay silent.
function fakeThree() {
  return stripe.disputes.sendBX3('dp_1');
}

/*
  Install then:
    import OpenAI from 'openai';
*/
// BX4: the import above is block-comment prose — the local OpenAI is not the
// SDK, so the constructed instance chain must stay silent.
const OpenAI = makeLocalFactory();
const oc = new OpenAI();
oc.chat.completions.markBX4({});

// BX5: a REAL require on a code line after the template closed still binds —
// the guard only skips matches on lines that START inside prose.
const stripeReal = require('stripe')('sk_test');
stripeReal.coupons.keepBX5('co_2');
