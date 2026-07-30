<?php
namespace App\Billing;

// Namespaced PHP negative fixture: relative references here resolve against
// App\Billing (e.g. App\Billing\Stripe\Charge), NOT the vendor namespace.
// Everything below must produce ZERO surfaces (AST track).

Stripe\Charge::create(['amount' => 100]);

$gateway = new Stripe\StripeClient('sk_test_789');
$gateway->payouts->create(['amount' => 50]);
