<?php
// Fixture: PHP pre-8.4 parenthesized construction (Loop 340).
// Before PHP 8.4 member access on a `new` expression required wrapping
// parens, so existing codebases carry both spellings:
//   $sc = (new StripeClient($k));            -> the var IS the client
//   $ch = (new StripeClient($k))->charges;   -> derived resource, silent
// Same trailer ruling as Loop 339, shifted one paren out.
namespace App;

use Stripe\StripeClient;

// PX1: bare paren wrap, use-bound class — binds.
$pxOne = (new StripeClient($apiKey));
$pxOne->tax_rates->wakePX1(['active' => true]);

// PX2: paren wrap with derived-resource trailer — silent.
$pxTwo = (new StripeClient($apiKey))->charges;
$pxTwo->subscriptions->dropPX2('sub_1');

// PX3: bare paren wrap, fully-qualified reference — binds.
$pxThree = (new \Stripe\StripeClient($apiKey));
$pxThree->balance_transactions->wakePX3('txn_1');

// PX4: paren wrap on ??= sugar — binds (Loop 330 ruling carries over).
$pxFour ??= (new StripeClient($apiKey));
$pxFour->tax_rates->wakePX4(['active' => false]);

// PX5: outer paren does NOT close right after the ctor call — the
// expression value is unproven, silent.
$pxFive = (new StripeClient($apiKey) && $flag);
$pxFive->subscriptions->dropPX5('sub_2');

// PX6: paren wrap with nullsafe trailer — silent.
$pxSix = (new StripeClient($apiKey))?->charges;
$pxSix->subscriptions->dropPX6('sub_3');

// PX7: prose lookalike in comment/string — silent.
// $pxSeven = (new StripeClient($apiKey));
$pxNote = '$pxSeven = (new StripeClient($apiKey));';
$pxSeven->subscriptions->dropPX7('sub_4');

// Loop 353: paren-wrapped construction with $this->field targets — the
// field twin of the var-target ruling above. Same trailer rules.
class PfGateway
{
    private $pfHold;
    private $pfFq;
    private $pfLazy;
    private $pfBad;
    private $pfExpr;

    public function bootA($key)
    {
        // PF1: bare paren wrap on a field, use-bound — binds.
        $this->pfHold = (new StripeClient($key));
        $this->pfHold->credit_notes->wakePF1('cn_1');
    }

    public function bootB($key)
    {
        // PF2: bare paren wrap on a field, fully-qualified — binds.
        $this->pfFq = (new \Stripe\StripeClient($key));
        $this->pfFq->setup_intents->wakePF2('seti_1');
    }

    public function bootC($key)
    {
        // PF3: paren wrap on ??= field sugar — binds.
        $this->pfLazy ??= (new StripeClient($key));
        $this->pfLazy->shipping_rates->wakePF3('shr_1');
    }

    public function bootD($key)
    {
        // PF4: paren wrap with derived-resource trailer — silent.
        $this->pfBad = (new StripeClient($key))->charges;
        $this->pfBad->subscriptions->dropPF4('sub_5');
    }

    public function bootE($key, $flag)
    {
        // PF5: outer paren does not close after the ctor — silent.
        $this->pfExpr = (new StripeClient($key) && $flag);
        $this->pfExpr->subscriptions->dropPF5('sub_6');
    }
}
