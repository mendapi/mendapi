<?php
// PHP negative fixture: no provider use statement / no fully-qualified
// provider reference anywhere. Same-shaped chains on unrelated local objects
// and nested vendor lookalikes must produce ZERO surfaces.

use App\Stripe\Helper;          // nested vendor namespace: root is App, not Stripe

$stripe = new Helper();
$stripe->customers->create(['email' => 'x@example.com']);

// relative (non-fully-qualified) reference — deliberately not proven
App\Stripe\Charge::create([]);

// bare class static call without any use proof
Charge::create([]);
