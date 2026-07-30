<?php
// Loop 306 fixture: PHP null-coalescing-assignment (`??=`) memoized
// constructor binding on $this-> fields. The lazy-init getter is the
// standard Laravel/Symfony service-class idiom:
//   public function client() { $this->client ??= new StripeClient($k); }
// Ruling: when the RHS is a proven construction, `??=` binds exactly like
// plain `=` (construct or keep the constructed value — Loop 305's Ruby
// `||=` ruling, PHP spelling). Non-proven `??=` writes feed the ambiguity
// guard and drop the field; local `$var ??=` binds since Loop 330
// (proven-class new RHS — Ruby bare-local `||=` parity).

use Stripe\StripeClient;

// NC1: memoized ??= constructor — MUST bind; chain below must surface.
class MemoizedService
{
    private $client;

    public function client($key)
    {
        $this->client ??= new StripeClient($key);
        return $this->client;
    }

    public function hold($args)
    {
        return $this->client->charges->holdNC1($args);
    }
}

// NC2: ??= constructor quoted in a block comment — must stay silent
// (bindingProseGuard territory: prose never mints a field).
class QuotedService
{
    private $sc;

    public function boot($key)
    {
        /* migration note: $this->sc ??= new StripeClient($key); */
        return null;
    }

    public function mark($args)
    {
        return $this->sc->refunds->markNC2($args);
    }
}

// NC3: proven ??= constructor PLUS a non-proven ??= write elsewhere —
// ambiguity guard must DROP the field; chain stays silent.
class ReassignedService
{
    private $conn;

    public function conn($key)
    {
        $this->conn ??= new StripeClient($key);
        return $this->conn;
    }

    public function inject($outside)
    {
        $this->conn ??= $outside;
    }

    public function ping($args)
    {
        return $this->conn->payouts->pingNC3($args);
    }
}

// NC4: local-variable ??= construction — binds since Loop 330 (proven
// new RHS on a use-bound class; the chain below must surface).
function localMemo($key)
{
    static $lc;
    $lc ??= new StripeClient($key);
    return $lc->coupons->bumpNC4(['id' => 'x']);
}
