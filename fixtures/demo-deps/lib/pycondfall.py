# Loop 316 fixture: Python same-operand conditional fallback bindings — the
# PEP 308 spelling of the `or`-fallback idiom (Loop 315) and the Python
# mirror of the JS `x ? x : new X()` verdict (Loop 310).
# CF1 binds, CF2/CF3/CF5 stay silent, CF4 binds via depth-1 module attribute.
from openai import OpenAI
import stripe

_memo = None


def cf1_binds():
    # Same-operand conditional fallback + proven from-import construction: binds.
    cfa = _memo if _memo else OpenAI(api_key="sk-test")
    return cfa.chat.completions.flipCF1(model="gpt-4o", messages=[])


def cf2_different_arm_silent(cached, other):
    # Value arm differs from the condition: bound name is only sometimes the
    # construction — backreference never matches, honest skip.
    cfb = other if cached else OpenAI(api_key="sk-test")
    return cfb.chat.completions.holdCF2(model="gpt-4o", messages=[])


def cf3_call_operand_silent():
    # Call-expression operand: not guaranteed idempotent — honest skip.
    cfc = fetch_memo() if fetch_memo() else OpenAI(api_key="sk-test")
    return cfc.chat.completions.markCF3(model="gpt-4o", messages=[])


class Cf4Service:
    def go(self, cached):
        # Depth-1 module-attribute construction behind the same fallback: binds.
        cfd = cached if cached else stripe.StripeClient("sk_test")
        return cfd.v1.customers.bumpCF4()


UPGRADE_NOTE = """
Old form quoted in prose — must never mint a binding:
cfe = cached if cached else OpenAI(key)
cfe.chat.completions.pingCF5(model="gpt-4o")
"""


def fetch_memo():
    return None
