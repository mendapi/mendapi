// Regex-literal masking regression (Loop 294). Both lines below used to be
// provider-level FALSE NEGATIVES before the scanner's regex masker:
//  - `/^\/\//` masked the rest of its own line as a `//` comment, hiding
//    the require() that follows it on the same line;
//  - `/foo\/*bar/` opened a phantom `/*` block comment that blacked out
//    every line below it in the file.
const isProto = /^\/\//.test(target); const stripe = require('stripe');
const splat = /foo\/*bar/;
const client = new stripe.Stripe(process.env.STRIPE_KEY);
