# Loop 311 fixture: Python conditional-expression (ternary) arm verdict —
# the Python mirror of the JS both-arms rule (Loop 304). A conditional RHS
# binds ONLY when the else arm is the SAME proven construction (the
# test/live-key idiom). Any other else arm (fake factory, None, different
# root) must stay silent: the bound name is only sometimes the proven
# client, and guessing would misfile every downstream chain.
import os

import stripe
from openai import OpenAI

# CA1 (positive): both arms are the same proven from-import construction —
# the test/live key idiom. Binds; the chain below must be inventoried.
ca_ai = OpenAI(api_key=os.environ["T"]) if os.environ.get("TEST") else OpenAI(api_key=os.environ["L"])
ca_r1 = ca_ai.chat.completions.flipCA1(model="gpt-4o", messages=[])

# CA2 (negative): else arm is an arbitrary factory — the bound name is only
# sometimes the client. Never binds; holdCA2 must stay silent.
ca_fake = OpenAI(api_key="t") if os.environ.get("REAL") else object()
ca_r2 = ca_fake.chat.completions.holdCA2(model="gpt-4o", messages=[])

# CA3 (positive): both arms are the same proven depth-1 module-attribute
# construction. Binds; the chain must be inventoried.
ca_sc = stripe.StripeClient("t") if os.environ.get("TEST") else stripe.StripeClient("l")
ca_r3 = ca_sc.payment_intents.markCA3()

# CA4 (negative): self-field with a None else arm — never mints a field.
class CondService:
    def __init__(self, key):
        self.client = OpenAI(api_key=key) if key else None

    def ask(self):
        return self.client.chat.completions.bumpCA4(model="gpt-4o", messages=[])

# CA5 (negative): walrus spelling with a non-proven else arm — never binds.
def ca_walrus(key):
    if (ca_w := OpenAI(api_key=key) if key else object()):
        return ca_w.chat.completions.pingCA5(model="gpt-4o", messages=[])
