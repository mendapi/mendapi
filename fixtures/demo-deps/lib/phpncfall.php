<?php
// Loop 319 fixture: PHP same-operand fallback construction binding — the
// memoized-singleton idiom, mirroring the Ruby `sc = sc || X.new` (Loop 317)
// and Python `x = x or X(k)` (Loop 315) rulings:
//   $sc = $sc ?? new StripeClient($k);
//   $sc = $sc ?: new StripeClient($k);
// Ruling: the backreference forces the fallback operand to be the SAME name
// as the target, so the bound name is either its own cached value or a
// proven construction — binds. Different operands, call-expression operands,
// and local `??=` sugar (Loop 306 ruling) all stay silent (AST track or
// honest skip).

use Stripe\StripeClient;

// NF1: same-operand `??` fallback on a local $var — MUST bind.
class CachedService
{
    public function hold($key, $args)
    {
        $scv = $scv ?? new StripeClient($key);
        return $scv->charges->holdNF1($args);
    }
}

// NF2: DIFFERENT operand (`$other ?? new ...`) — must stay silent (the
// bound name is only sometimes a proven client; AST track).
class HandoffService
{
    public function mark($other, $key, $args)
    {
        $scw = $other ?? new StripeClient($key);
        return $scw->charges->markNF2($args);
    }
}

// NF3: same-operand Elvis (`?:`) fallback — MUST bind (truthiness check on
// the same name; either arm leaves a proven construction or the cached one).
class ElvisCacheService
{
    public function ping($key, $args)
    {
        $scx = $scx ?: new StripeClient($key);
        return $scx->disputes->wakeNF3($args);
    }
}

// NF4: field verbose form (`$this->f = $this->f ?? new ...`) — MUST bind
// and survive the ambiguity guard (the proof feeds phpProvenIdx).
class FieldCacheService
{
    private $cly;

    public function bump($key, $args)
    {
        $this->cly = $this->cly ?? new StripeClient($key);
        return $this->cly->invoices->bumpNF4($args);
    }
}

// NF5: call-expression operand (`getCached() ?? new ...`) — must stay
// silent (idempotence not guaranteed; honest skip).
class FactoryService
{
    public function flip($key, $args)
    {
        $scz = self::getCached() ?? new StripeClient($key);
        return $scz->products->flipNF5($args);
    }

    private static function getCached()
    {
        return null;
    }
}
