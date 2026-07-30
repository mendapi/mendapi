<?php
// Loop 326 fixture: bare `$this->f = null;` constructor placeholder
// whitelist. The standard class-based service idiom pairs a null init in
// the constructor with a guarded-if lazy-init:
//   public function __construct() { $this->client = null; }
//   if (!$this->client) $this->client = new StripeClient($key);
// Ruling (mirror of Loop 324 Python None / Loop 325 JS null): null carries
// zero construction ambiguity — "not built yet", never "built as something
// else" — so a bare null placeholder may keep the guarded proof. Strictly
// plain `=` with a bare null literal to end of statement; conditionals and
// calls still drop via the ambiguity guard.

use Stripe\StripeClient;

// NG1: null placeholder + guarded-if lazy-init — MUST bind; chain surfaces.
class PlaceholderService
{
    private $ng1;

    public function __construct()
    {
        $this->ng1 = null;
    }

    public function client($key)
    {
        if (!$this->ng1) $this->ng1 = new StripeClient($key);
        return $this->ng1;
    }

    public function wake($args)
    {
        return $this->ng1->balance->wakeNG1($args);
    }
}

// NG2: conditional null RHS in the constructor — NOT a bare null literal;
// the ambiguity guard must DROP the field; chain stays silent.
class ConditionalService
{
    private $ng2;

    public function __construct($flag)
    {
        $this->ng2 = $flag ? null : $this->makeOther();
    }

    public function client($key)
    {
        if (!$this->ng2) $this->ng2 = new StripeClient($key);
        return $this->ng2;
    }

    public function drop($args)
    {
        return $this->ng2->disputes->dropNG2($args);
    }

    private function makeOther()
    {
        return null;
    }
}
