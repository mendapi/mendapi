<?php
// Positive control (Loop 300): a heredoc must not black out REAL code below
// it — an unterminated-looking body or the closer line must hand back code
// position so the genuine `use` + constructor lines keep being found.
$docBlurb = <<<TXT
This worker charges cards. A glob like /*.php appears here on purpose.
TXT;

use Stripe\StripeClient;

$client = new \Stripe\StripeClient(getenv('STRIPE_KEY'));
$client->charges->retrieve($chargeId);
