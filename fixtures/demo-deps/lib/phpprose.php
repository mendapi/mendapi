<?php
// PHP prose-masking fixture (Loop 299): comment / string / heredoc quotes of
// constructor lines and chains must never mint bindings or surfaces; real
// code before and after prose containers must still bind.

use Stripe\StripeClient;

// PP1 — block-comment constructor quote: no phantom $var binding, and the
// same-named PARAMETER below stays silent.
/*
 Migration note (old bootstrap):
 $client = new StripeClient($key);
*/
class BillingSvcPP {
    public function run($client) {
        return $client->charges->holdPP1(['amount' => 100]);
    }
}

// PP2 — heredoc-body constructor quote: no phantom binding, same-named
// parameter silent; code AFTER the closer still binds (PP4 below).
$docPP = <<<NOTE
Before v10 you wrote:
$sc = new StripeClient($key);
NOTE;
function refundItPP($sc) {
    return $sc->refunds->markPP2(['charge' => 'ch_1']);
}

// PP3 — block-comment $this->field constructor quote: no phantom field,
// $this-> chain on that field stays silent.
/*
 old service wiring:
 $this->pay = new StripeClient($key);
*/
class PaySvcPP {
    public function go() {
        return $this->pay->payouts->pingPP3(['amount' => 5]);
    }
}

// PP5 — line-comment and string chain lookalikes never surface.
// $real->tokens->ghostPP5a([]);
# $real->plans->ghostPP5b([]);
$notePP = '$real->prices->ghostPP5c([])';

// PP4 — real constructor + chain after all the prose above still binds.
$real = new StripeClient('sk_test');
$real->coupons->bumpPP4(['id' => 'x']);
