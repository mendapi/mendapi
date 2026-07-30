# Loop 308 fixture: Python setter hand-off prose guards
# (the Python mirror of the TS setter fix, Loop 307): the hand-off matcher
# (`self.f = p` under a type-annotated single-line def signature) is
# line-anchored but a docstring / triple-quoted constant line starts at
# column 0 too — a migration note quoting the hand-off statement minted a
# PHANTOM FIELD and every same-file `self.f.` chain was mis-attributed to
# the SDK. bindingProseGuard (multi-line prose container) now rejects those
# matches; a guarded-away real hand-off can only DROP a field (miss, never
# a false positive) — the safe direction.
from openai import OpenAI
import stripe


class RealHandOff:
    # positive control: real hand-off under an annotated signature binds
    def set_client(self, hoc: OpenAI):
        self.hoc = hoc

    def ask(self, q):
        return self.hoc.chat.completions.holdHF1(model="gpt", messages=q)


class DocstringQuoted:
    # negative: hand-off quoted inside a method docstring never mints a
    # field — the annotated signature is real but the ONLY hand-off
    # spelling lives in prose
    def set_client(self, dqc: OpenAI):
        self._sink = 1

    def note(self):
        """Migration note (old form):
        self.dqc = dqc
        """
        return self.dqc.chat.completions.markHF2(model="x")


NOTE = """
upgrade guide (module-attribute annotation form):
    self.tqs = tqs
"""


class TripleQuotedConstant:
    # negative: hand-off quoted inside a module-level triple-quoted
    # constant never mints a field (depth-1 module-attribute annotation)
    def set_stripe(self, tqs: stripe.StripeClient):
        self._sink = 2

    def bill(self, cid):
        return self.tqs.payment_intents.pingHF3(cid)
