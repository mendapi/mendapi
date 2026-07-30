<?php
// PHP chained-assignment fixture (Loop 351): `$sc = $client = new StripeClient($k)`
// binds BOTH targets (assignment is an expression — the inner assignment
// evaluates to the constructed client). Derived trailers, 3+ targets and
// prose lookalikes must all stay silent.

use Stripe\StripeClient;

// use-bound chained assignment — both names hold the client
$qpOne = $qpTwo = new StripeClient($key);
$qpOne->tokens->wakeQP1(['card' => $c]);
$qpTwo->mandates->wakeQP2('mdt_1');

// fully-qualified chained assignment — both names hold the client
$qpThree = $qpFour = new \Stripe\StripeClient($key);
$qpThree->tokens->wakeQP3(['card' => $c]);
$qpFour->mandates->wakeQP4('mdt_2');

// derived trailer: the chained value is a resource, NEITHER name binds
$qpFive = $qpSix = new StripeClient($key)->charges;
$qpFive->tokens->dropQP5(['x' => 1]);
$qpSix->mandates->dropQP6('mdt_3');

// 3+ targets: honest skip (AST track) — no partial inner-pair binding
$qpA = $qpB = $qpC = new StripeClient($key);
$qpA->tokens->dropQP7(['x' => 1]);

// prose lookalike inside a heredoc body: never mints
$qpDoc = <<<EOT
$qpX = $qpY = new StripeClient($key);
$qpX->tokens->dropQP8(['x' => 1]);
EOT;

// Loop 352: chained assignment with $this->field targets — the field
// spelling of the same expression proof. Field names are unique per file
// (the file-level ambiguity guard unbinds re-assigned fields).
class QfBilling {
    private $qfHold;
    private $qfPrime;
    private $qfAlias;
    private $qfFq;
    private $qfBad;
    private $qfMany;

    public function bootA($key) {
        // field-outer / var-inner: BOTH names hold the client
        $this->qfHold = $qfLocalA = new StripeClient($key);
        $this->qfHold->invoices->wakeQF1('in_1');
        $qfLocalA->quotes->wakeQF2('qt_1');
    }

    public function bootB($key) {
        // var-outer / field-inner: BOTH names hold the client
        $qfLocalB = $this->qfPrime = new StripeClient($key);
        $qfLocalB->payouts->wakeQF3('po_1');
        $this->qfPrime->coupons->wakeQF4('cp_1');
    }

    public function bootC($key) {
        // field-outer / field-inner: BOTH fields hold the client
        $this->qfAlias = $this->qfTwin = new StripeClient($key);
        $this->qfAlias->plans->wakeQF5('pl_1');
        $this->qfTwin->prices->wakeQF6('pr_1');
    }

    public function bootD($key) {
        // fully-qualified field-outer chain
        $this->qfFq = $qfLocalC = new \Stripe\StripeClient($key);
        $this->qfFq->products->wakeQF7('re_1');
    }

    public function bootE($key) {
        // derived trailer: the chained value is a resource, NEITHER binds
        $this->qfBad = $qfLocalD = new StripeClient($key)->charges;
        $this->qfBad->tokens->dropQF8(['x' => 1]);
    }

    public function bootF($key) {
        // 3+ targets with a field: honest skip (AST track)
        $this->qfMany = $qfM1 = $qfM2 = new StripeClient($key);
        $this->qfMany->tokens->dropQF9(['x' => 1]);
    }
}

// Loop 354: chained assignment with a PAREN-WRAPPED ctor — the outer
// target binds too (Loop 340 outerParen ruling composed with the chained
// assignment proof). Derived trailers and non-tight parens stay silent.

// var-outer / var-inner paren-wrap: outer name holds the client
$qwOne = $qwTwo = (new StripeClient($key));
$qwOne->accounts->wakeQW1('acct_1');

class QwGateway {
    private $qwHold;
    private $qwPrime;
    private $qwAlias;
    private $qwTwinB;
    private $qwBad;

    public function bootA($key) {
        // field-outer / var-inner paren-wrap
        $this->qwHold = $qwLocalA = (new StripeClient($key));
        $this->qwHold->sources->wakeQW2('src_1');
    }

    public function bootB($key) {
        // var-outer / field-inner paren-wrap (fully-qualified)
        $qwLocalB = $this->qwPrime = (new \Stripe\StripeClient($key));
        $qwLocalB->orders->wakeQW3('or_1');
    }

    public function bootC($key) {
        // field-outer / field-inner paren-wrap
        $this->qwAlias = $this->qwTwinB = (new StripeClient($key));
        $this->qwAlias->topups->wakeQW4('tu_1');
    }

    public function bootD($key) {
        // derived trailer after the outer close: NEITHER name binds
        $this->qwBad = $qwLocalC = (new StripeClient($key))->charges;
        $this->qwBad->tokens->dropQW5(['x' => 1]);
    }
}

// non-tight paren: expression value unproven, outer name never binds
$qwExpr = $qwInner = (new StripeClient($key) ?: null);
$qwExpr->tokens->dropQW6(['x' => 1]);
