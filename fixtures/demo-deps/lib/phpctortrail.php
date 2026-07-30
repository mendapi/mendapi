<?php
// Fixture: PHP constructor trailing-chain adjudication (Loop 339).
// PHP 8.4 allows member access on a `new` expression without wrapping
// parens: `$sc = new StripeClient($k)->charges;` binds $sc to a DERIVED
// resource, not the client. Any `->` / `?->` trailer after the ctor's
// balanced close drops the binding (mirrors Ruby Loop 337, JS/Python 338).
namespace App;

use Stripe\StripeClient;

// CX1: plain construction, no trailer — binds (control).
$cxOne = new StripeClient($apiKey);
$cxOne->charges->wakeCX1(['amount' => 100]);

// CX2: derived-resource trailer on the local declaration — the var holds
// charges, NOT the client. Silent.
$cxTwo = new StripeClient($apiKey)->charges;
$cxTwo->subscriptions->dropCX2('sub_1');

// CX3: derived trailer on the $this->field assignment — silent.
class CxHolder
{
    private $cxf;

    public function __construct($k)
    {
        $this->cxf = new StripeClient($k)->charges;
    }

    public function go()
    {
        $this->cxf->subscriptions->dropCX3('sub_2');
    }
}

// CX4: derived trailer on the ??= sugar — silent.
$cxFour ??= new StripeClient($apiKey)->charges;
$cxFour->subscriptions->dropCX4('sub_3');

// CX5: derived trailer on the same-operand fallback — silent.
$cxFive = $cxFive ?? new StripeClient($apiKey)->charges;
$cxFive->subscriptions->dropCX5('sub_4');

// CX6: derived trailer on the ternary alternate arm — silent.
$cxSix = $isTest ? new StripeClient($testKey) : new StripeClient($liveKey)->charges;
$cxSix->subscriptions->dropCX6('sub_5');

// CX7: multi-line argument list, clean close — binds (control).
$cxSeven = new StripeClient(
    $apiKey
);
$cxSeven->disputes->wakeCX7('dp_1');

// CX8: nullsafe trailer after the ctor close — silent.
$cxEight = new StripeClient($apiKey)?->charges;
$cxEight->subscriptions->dropCX8('sub_6');
