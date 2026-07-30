<?php
// PHP SDK binding fixture: use-statement bindings (plain, alias, group form),
// $variable instances, and fully-qualified static calls must all be
// inventoried; comment mentions must not.

use Stripe\StripeClient;
use Twilio\Rest\Client as TwilioClient;

$stripe = new StripeClient('sk_test_123');
$stripe->customers->create(['email' => 'a@example.com']);
$stripe->checkout->sessions->create(['mode' => 'payment']);

// fully-qualified static call — leading backslash is the root proof
\Stripe\Charge::create(['amount' => 100]);

$twilio = new TwilioClient($sid, $token);
$twilio->messages->create('+155****0000', ['body' => 'hello']);

// Loop 200: nullsafe member access (?->, PHP 8.0+) on a proven instance is
// the same chain proof — pure and mixed spellings must be inventoried.
$stripe?->terminal?->readers?->registerQM1(['label' => 'l']);
$stripe->checkout?->sessions->expireQM2($id);
// negative positions for the nullsafe form:
$mystery?->disputes?->closeQM3($id);                    // unproven root
// $stripe?->coupons?->createQM4([]);                    <- comment chain: no surface
$note = '\$stripe?->mandates?->retrieveQM5(x) by hand'; // string mention (escaped $)

// negative positions:
// $stripe->refunds->create([]);            <- comment chain: no surface
// use Stripe\Terminal\Reader;              <- comment use: no binding
$label = "\\Stripe\\Payout::create";        // string mention, no call parens

// Loop 204: class-property constructor binding — the PHP service-class idiom
// ($this->field = new ProvenClass(...)), symmetric with the JS this-field
// form (Loop 203). Chains rooted at $this-> dispatch on the field; the
// ambiguity guard drops fields also assigned from non-proven RHS.
class PaymentSvcCP {
    public function __construct($key) {
        $this->sc = new StripeClient($key);
    }
    public function charge($a) {
        return $this->sc->charges->createCP1($a);       // binds (field+member+method)
    }
    public function cancel($id) {
        return $this->sc?->subscriptions?->cancelCP2($id); // nullsafe segs bind too
    }
    public function thin() {
        return $this->sc->pingCP3(1);                   // two segments: too thin, no surface
    }
}
class AmbiguousSvcCP {
    public function __construct($key, $other) {
        $this->amb = new StripeClient($key);
        $this->amb = $other;                            // ambiguity guard: field dropped
    }
    public function go() {
        return $this->amb->refundsx->createCP4([]);     // no surface
    }
    public function cmp() {
        if ($this->sc == null) { return null; }         // comparison never unbinds
    }
}
// comment lookalike: $this->sc->coupons->createCP5([]);
$noteCP = 'call \$this->sc->mandates->retrieveCP6(1) later'; // escaped-$ string mention

// Loop 205: DI-injected and type-hinted class properties — the type hint is
// the proof. Three positive spellings: type-hinted ctor param hand-off,
// promoted constructor property (PHP 8.0), typed property declaration.
class InjectedSvcDI {
    public function __construct(StripeClient $scdi) {
        $this->scdi = $scdi;
    }
    public function pay($a) {
        return $this->scdi->payment_intents->confirmDI1($a);  // binds via ctor-param type hint
    }
}
class PromotedSvcDI {
    public function __construct(private readonly TwilioClient $twdi) {}
    public function send($m) {
        return $this->twdi->messages->createDI2($m);          // binds via promoted property
    }
}
class TypedPropSvcDI {
    private ?StripeClient $tpdi;
    public function go($a) {
        return $this->tpdi->setup_intents->confirmDI3($a);    // binds via typed property
    }
}
// negatives: reassigned param dropped / untyped param no proof
class ReassignedParamDI {
    public function __construct(StripeClient $rp) {
        $rp = null;
        $this->rpf = $rp;
    }
    public function go() { return $this->rpf->chargesx->createDI4([]); } // no surface
}
class UntypedParamDI {
    public function __construct($up) { $this->upf = $up; }
    public function go() { return $this->upf->chargesx->createDI5([]); } // no surface
}

// Loop 207: setter injection — any single-line method signature carries the
// same type-hint proof as __construct (Symfony/Laravel optional-dependency
// setter injection).
class SetterSvcSJ {
    private $sjc;
    public function setClient(StripeClient $sjc) {
        $this->sjc = $sjc;
    }
    public function pay($a) {
        return $this->sjc->payment_links->openSJ1($a);   // binds via setter type hint
    }
}
class ReusedParamSJ {
    // negative: the same param name appears in two signatures -> file-level
    // ambiguity, every hand-off from it is dropped
    public function setA(StripeClient $rpq) { $this->ra = $rpq; }
    public function setB($rpq) { $this->rb = $rpq; }
    public function go() { return $this->ra->chargesx->openSJ2([]); }  // no surface
}

// Loop 222: multi-line (PSR-12/Prettier-wrapped) method signatures — the
// balanced-paren walk collects the wrapped param list; the type hint carries
// exactly the same proof as the single-line form.
class WrappedCtorMC {
    public function __construct(
        StripeClient $wsc,
        \Psr\Log\LoggerInterface $wlog,
    ) {
        $this->wsc = $wsc;
    }
    public function pay($a) {
        return $this->wsc->payment_intents->confirmMW1($a);  // binds via wrapped ctor type hint
    }
}
class WrappedSetterMC {
    public function setGateway(
        TwilioClient $wtw,
    ) { $this->wtw = $wtw; }
    public function send($m) {
        return $this->wtw->messages->sendMW2($m);          // binds via wrapped setter type hint
    }
}
class WrappedNegMC {
    public function __construct(
        // StripeClient $wneg,                               <- commented lookalike: no proof
        $wneg,
        string $tag = 'takes a StripeClient $sneg later',
        $sneg,
    ) {
        $this->wn = $wneg;
        $this->sg = $sneg;
    }
    public function go() {
        return $this->wn->chargesx->buildMW3([]);           // no surface (untyped)
    }
    public function go2() {
        return $this->sg->chargesx->retrieveMW4([]);         // no surface (string lookalike)
    }
}
