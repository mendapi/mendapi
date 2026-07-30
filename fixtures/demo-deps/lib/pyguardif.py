# Loop 322 fixture: Python single-line guarded-if lazy-init bindings — the
# Python spelling of the JS Loop 320 guarded-if verdict.
# PG1 binds (bare falsy), PG2 binds (is None, depth-1 module attribute),
# PG3/PG4/PG5 stay silent.
from openai import OpenAI
import stripe

_pga = None
_pgb = None
_pgc = None
_pgd = None


def pg1_binds(k):
    # Bare-falsy guard, same operand as target: binds.
    global _pga
    if not _pga: _pga = OpenAI(api_key=k)
    return _pga.chat.completions.flipPG1(model="gpt-4o", messages=[])


def pg2_binds(k):
    # None-equality guard + depth-1 module-attribute construction: binds.
    global _pgb
    if _pgb is None: _pgb = stripe.StripeClient(k)
    return _pgb.v1.customers.holdPG2()


def pg3_different_target_silent(k):
    # Guard operand differs from the assignment target: after the statement
    # the target may hold anything — honest skip.
    global _pgc
    other = None
    if not _pgc: other = OpenAI(api_key=k)
    return other.chat.completions.markPG3(model="gpt-4o", messages=[])


def pg4_compound_condition_silent(k, ready):
    # Compound condition: construction not guaranteed — honest skip (AST track).
    global _pgd
    if ready and not _pgd: _pgd = OpenAI(api_key=k)
    return _pgd.chat.completions.bumpPG4(model="gpt-4o", messages=[])


UPGRADE_NOTE = """
Old form quoted in prose — must never mint a binding:
if not _pge: _pge = OpenAI(key)
_pge.chat.completions.pingPG5(model="gpt-4o")
"""
