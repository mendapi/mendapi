# Loop 315 fixture: Python `or`-fallback constructor bindings — the Python
# spelling of the JS memoized-singleton fallback idiom (Loop 239).
# OF1 binds, OF2/OF3/OF5 stay silent, OF4 binds via depth-1 module attribute.
from openai import OpenAI
import stripe

_cached = None


def of1_binds():
    # Simple dotted-chain operand + proven from-import construction: binds.
    client = _cached or OpenAI(api_key="sk-test")
    return client.chat.completions.flipOF1(model="gpt-4o", messages=[])


def of2_call_operand_silent():
    # Call-expression operand: not guaranteed idempotent — honest skip.
    clh = get_cached() or OpenAI(api_key="sk-test")
    return clh.chat.completions.holdOF2(model="gpt-4o", messages=[])


def of3_and_silent(flag):
    # `and` never guarantees construction (falsy flag leaves name falsy).
    clm = flag and OpenAI(api_key="sk-test")
    return clm.chat.completions.markOF3(model="gpt-4o", messages=[])


class Of4Service:
    def go(self, cached):
        # Depth-1 module-attribute construction behind the same fallback: binds.
        sc = cached or stripe.StripeClient("sk_test")
        return sc.v1.customers.bumpOF4()


MIGRATION_NOTE = """
Old form quoted in prose — must never mint a binding:
clp = cached or OpenAI(key)
clp.chat.completions.pingOF5(model="gpt-4o")
"""


def get_cached():
    return None
