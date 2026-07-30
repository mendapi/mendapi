<?php
// Global-namespace PHP fixture: this file declares NO namespace, so relative
// provider references resolve from the global namespace (PHP name resolution
// rules) and are provable without a `use` statement or leading backslash.

// relative static call — provable here (global namespace)
Stripe\CountrySpec::all(['limit' => 3]);

// relative constructor + instance chain
$sc = new Stripe\StripeClient('sk_test_456');
$sc->invoices->finalizeInvoice('in_123');

// negative positions:
// Stripe\Refund::create([]);                 <- comment mention: no surface
$note = 'Stripe\\Coupon::create';             // string, no call parens
App\Stripe\Charge::create([]);                // nested vendor namespace: root is App
