"""Loop 323 fixture: single-line guarded-if lazy-init on self fields.

YG1 binds (bare-falsy guard, from-import construction);
YG2 binds (is-None guard, depth-1 module-attribute construction);
YG3 silent (guard operand differs from assignment target);
YG4 silent (compound condition — honest skip);
YG5 silent (lookalike quoted inside triple-quoted prose).

YG6 binds (Loop 324: plain `self.x = None` placeholder in __init__ is
whitelisted — "not yet constructed" is not "a different construction",
so it no longer drops the proven guarded-if binding);
YG7 silent (conditional None RHS is NOT the bare None literal — the
ambiguity guard still drops it, safe direction unchanged).
"""
from openai import OpenAI
import stripe


class BillingService:
    def __init__(self, flag):
        self.ygf = None  # canonical lazy-init placeholder
        self.ygg = None if flag else object()

    def cached_ask(self, key):
        if not self.ygf: self.ygf = OpenAI(api_key=key)
        return self.ygf.chat.completions.wakeYG6(model="gpt-4o")

    def maybe_ask(self, key):
        if not self.ygg: self.ygg = OpenAI(api_key=key)
        return self.ygg.chat.completions.dropYG7(model="gpt-4o")

    def ask(self, key):
        if not self.yga: self.yga = OpenAI(api_key=key)
        return self.yga.chat.completions.flipYG1(model="gpt-4o")

    def charge(self, key):
        if self.ygb is None: self.ygb = stripe.StripeClient(key)
        return self.ygb.v1.customers.holdYG2("cus_123")

    def wrong_target(self, key):
        if not self.other_flag: self.ygc = OpenAI(api_key=key)
        return self.ygc.embeddings.markYG3(model="text-embedding-3-small")

    def compound(self, key):
        if self.ready and not self.ygd: self.ygd = OpenAI(api_key=key)
        return self.ygd.chat.completions.bumpYG4(model="gpt-4o")

    def prose(self):
        note = """
        if not self.yge: self.yge = OpenAI(api_key=key)
        """
        return note
