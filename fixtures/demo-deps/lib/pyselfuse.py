# Loop 209 fixture: Python instance-attribute constructor bindings
# (`self.<field> = OpenAI(...)` / `self.<field> = stripe.StripeClient(...)`)
from openai import OpenAI
import stripe


class PaymentService:
    def __init__(self, key):
        # positive: pyClass from-import constructor hand-off
        self.ai = OpenAI(api_key=key)
        # positive: depth-1 module-attribute constructor, PEP 526 annotated
        self.sc: stripe.StripeClient = stripe.StripeClient(key)

    def ask(self, q):
        return self.ai.chat.completions.confirmSF1(model="gpt", messages=q)

    def bill(self, cid):
        return self.sc.payment_intents.captureSF2(cid)

    def thin(self):
        # negative: two segments (field + method) — attribution too thin
        return self.sc.pingSF3(1)


class Reassigned:
    # field name deliberately distinct from PaymentService.ai — the guard is
    # file-level, and sharing the name would (correctly) drop the positive too
    def __init__(self, key):
        self.rc = OpenAI(api_key=key)

    def swap(self, other):
        # negative: non-proven reassignment drops the field (ambiguity guard)
        self.rc = other

    def use(self):
        return self.rc.chat.completions.confirmSF4(model="x")


class Unproven:
    def __init__(self, key):
        # negative: unproven RHS never binds
        self.thing = build_local(key)
        # negative: deep module chain RHS is API data, not a client
        self.sess = stripe.checkout.sessions.create(key)

    def use(self):
        self.thing.charges.confirmSF5(1)
        return self.sess.line_items.listSF6()


# negative: comment lookalike never binds
# self.ghost = OpenAI(k); self.ghost.chat.completions.confirmSF7(model="x")


class InlineSuite:
    # Loop 213: single-line compound-statement suites and `;`-separated
    # second statements are proven inline positions (suite colon after `)`,
    # else/try/finally keywords, or a `;` statement boundary).
    def __init__(self, key): self.ic = OpenAI(api_key=key)

    def ask(self, q):
        return self.ic.chat.completions.confirmIS1(model="gpt", messages=q)


class InlineSecond:
    def __init__(self, key): self.n = 0; self.isc = stripe.StripeClient(key)

    def bill(self, cid):
        return self.isc.payment_intents.captureIS2(cid)


class InlineBranch:
    def __init__(self, key):
        if key: self.bc = OpenAI(api_key=key)
        else: self.bc = OpenAI(api_key="test")

    def go(self, q):
        return self.bc.chat.completions.confirmIS3(model="x", messages=q)


class InlineDropped:
    def __init__(self, key): self.dc = OpenAI(api_key=key)

    # negative: inline non-proven reassignment drops the field (guard is
    # extended to inline positions, deliberately without the prose guard)
    def swap(self, o): self.dc = o

    def use(self):
        return self.dc.chat.completions.confirmIS4(model="x")


def inline_lookalikes():
    # negative: in-string inline lookalike never binds (prose guard)
    s = "def x(self): self.g1 = OpenAI(k); self.g1.chat.completions.confirmIS5(model='x')"
    return s
    # negative: commented inline lookalike — def y(self): self.g2 = OpenAI(k); self.g2.chat.completions.confirmIS6(model="x")
