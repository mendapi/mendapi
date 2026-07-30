<?php
// Fixture: PHP local `??=` memoized lazy-init construction (Loop 330).
// The include-based legacy script idiom: `$sc ??= new StripeClient($k)`.
namespace App;

use Stripe\StripeClient;

// QL1: bare local ??= with proven-class new RHS — binds.
$qlOne ??= new StripeClient($apiKey);
$qlOne->charges->wakeQL1(['amount' => 100]);

// QL2: null placeholder + ??= pair (bootstrap-file spelling) — binds.
$qlTwo = null;
$qlTwo ??= new \Stripe\StripeClient($apiKey);
$qlTwo->transfers->wakeQL2('tr_1');

// QL3: non-proven factory RHS — never binds.
$qlThree ??= makeClientQL($apiKey);
$qlThree->payouts->dropQL3('po_1');

// QL4: prose lookalike in comment and string — never mints.
// $qlFour ??= new StripeClient($apiKey); $qlFour->disputes->dropQL4('dp');
$qlMsg = '$qlFour ??= new StripeClient($apiKey); $qlFour->disputes->dropQL4("dp");';

// QL5: comparison operator is not an assignment — never binds.
if ($qlFive == new StripeClient($apiKey)) {
    $qlFive->topups->dropQL5('tu_1');
}
