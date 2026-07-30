<?php
// Fixture: PHP direct inline constructor chain consumption (Loop 341).
// Both spellings construct and consume in one expression, no variable:
//   (new StripeClient($k))->tax_ids->create([...]);     pre-8.4 paren wrap
//   new StripeClient($k)->exchange_rates->retrieve(...) 8.4 paren-less
// The class reference is the proof; the same-line balanced-paren walk makes
// the read provable without AST. A trailing call paren is required so bare
// property reads never mint a surface.
namespace App;

use Stripe\StripeClient;

// IX1: paren-wrapped direct inline chain, use-bound class — emits.
(new StripeClient($apiKey))->tax_ids->wakeIX1(['type' => 'eu_vat']);

// IX2: paren-wrapped direct inline chain, fully-qualified reference — emits.
(new \Stripe\StripeClient($apiKey))->country_specs->wakeIX2('US');

// IX3: 8.4 paren-less direct inline chain — emits.
new StripeClient($apiKey)->exchange_rates->wakeIX3('usd');

// IX4: assignment of a derived-chain CALL result — the call emits, but the
// variable holds API data, never the client (Loop 339/340 trailer ruling).
$ixFour = (new StripeClient($apiKey))->tax_ids->wakeIX4(['type' => 'gb_vat']);
$ixFour->subscriptions->dropIX4('sub_1');

// IX5: outer paren is an expression, not a bare ctor wrap — silent.
($flag && new StripeClient($apiKey))->subscriptions->dropIX5('sub_2');

// IX6: prose lookalikes never emit — silent.
// (new StripeClient($apiKey))->subscriptions->dropIX6a('sub_3');
$ixNote = '(new StripeClient($apiKey))->subscriptions->dropIX6b("sub_4");';

// IX7: multi-line argument list — ctor close is not line-anchored evidence,
// honest skip (AST track), silent.
(new StripeClient(
    $apiKey
))->subscriptions->dropIX7('sub_5');
