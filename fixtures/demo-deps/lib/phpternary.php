<?php
// Loop 312 fixture: PHP both-arms ternary construction binding — the
// test/live key idiom, mirroring the JS (Loop 304) and Python (Loop 311)
// rulings:
//   $sc = $isTest ? new StripeClient($testKey) : new StripeClient($liveKey);
// Ruling: when BOTH arms construct from the same proven class reference,
// whichever arm wins the variable holds a construction — binds. Single-arm
// forms (`: null` / `: makeFake()`), the Elvis operator (`?:`), nullsafe
// (`?->`) conditions, and multi-line arg lists all stay silent (AST track
// or honest skip).

use Stripe\StripeClient;

// TC1: both-arms ternary on a local $var — MUST bind; chain must surface.
class KeyedService
{
    public function hold($isTest, $testKey, $liveKey, $args)
    {
        $sc = $isTest ? new StripeClient($testKey) : new StripeClient($liveKey);
        return $sc->charges->holdTC1($args);
    }
}

// TC2: single-arm ternary (`: null`) — must stay silent (arm arbitrary).
class LazyService
{
    public function mark($t, $key, $args)
    {
        $scm = $t ? new StripeClient($key) : null;
        return $scm->charges->markTC2($args);
    }
}

// TC3: Elvis operator (`?:`) — must stay silent (the truthy arm is the
// condition itself, not a proven construction; separate ruling).
class ElvisService
{
    public function ping($cached, $key, $args)
    {
        $sce = $cached ?: new StripeClient($key);
        return $sce->charges->pingTC3($args);
    }
}

// TC4: both-arms ternary on a $this-> field — MUST bind; the ternary proof
// feeds phpProvenIdx so the ambiguity guard keeps it.
class FieldService
{
    private $sc;

    public function __construct($t, $a, $b)
    {
        $this->sc = $t ? new StripeClient($a) : new StripeClient($b);
    }

    public function bump($args)
    {
        return $this->sc->charges->bumpTC4($args);
    }
}

// TC5: both-arms ternary field PLUS a non-proven reassignment elsewhere —
// the ambiguity guard must drop the field (never guess).
class SwappedService
{
    private $cl;

    public function __construct($t, $a, $b)
    {
        $this->cl = $t ? new StripeClient($a) : new StripeClient($b);
    }

    public function swap($x)
    {
        $this->cl = $x;
    }

    public function flip($args)
    {
        return $this->cl->charges->flipTC5($args);
    }
}

// TC6 (Loop 313): nullsafe property read in the CONDITION with both arms
// constructing — MUST bind. The `?->` belongs to the condition, not the
// ternary; both arms still prove the construction.
class NullsafeCondService
{
    public function spin($cfg, $a, $b, $args)
    {
        $scn = $cfg?->useTest ? new StripeClient($a) : new StripeClient($b);
        return $scn->charges->spinTC6($args);
    }
}

// TC7 (Loop 313): nullsafe condition but single-arm (`: null`) — must stay
// silent (arm arbitrary, same ruling as TC2).
class NullsafeLazyService
{
    public function quiet($cfg, $a, $args)
    {
        $scq = $cfg?->useTest ? new StripeClient($a) : null;
        return $scq->charges->quietTC7($args);
    }
}
