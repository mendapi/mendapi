# Loop 286: module-binding matchers must not mint bindings from imports that
# live inside multi-line prose containers (docstrings / triple-quoted
# constants). Before the guard, the docstring import below bound `stripe`
# file-wide and the top-level lookalike chain minted a false surface.
DOC = """
Example setup:
    import stripe
"""


def fake_one(x):
    # BX1: `stripe` was never really imported in this file — the only
    # "import" is docstring prose, so this chain must stay silent.
    return x and stripe.Topup.fetchBX1("tu_1")


HELP = """
Quickstart:
    from stripe import StripeClient
"""


def fake_two():
    # BX2: the from-import above is docstring prose — constructing
    # StripeClient must not bind an instance, and the chain stays silent.
    c = StripeClient("sk_test")
    return c.coupons.holdBX2("co_1")
