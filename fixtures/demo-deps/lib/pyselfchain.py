"""Chained-assignment self-field binding fixture (Loop 358).

Python chained assignment with a self-field target binds every target to
the same constructed client (Loop 348 semantics composed with the Loop 209
self-field proof). Field-first, var-first and field-to-field two-target
forms bind; derived trailers, 3+ targets and prose lookalikes stay silent.
"""

import stripe
from openai import OpenAI


class FieldFirst:
    def __init__(self, key):
        # QY1/QY2 (positive): pyClass chained — field AND var both consume.
        self.oa_qy = oa_client_qy = OpenAI(api_key=key)
        self.oa_qy.realtime.wakeQY1(model="gpt-4o-realtime")
        oa_client_qy.moderations.wakeQY2(input="x")


class VarFirst:
    def __init__(self, key):
        # QY3/QY4 (positive): pyModule depth-1 chained, var-first — both consume.
        st_client_qy = self.st_qy = stripe.StripeClient(key)
        st_client_qy.quotes.wakeQY3("qt_1")
        self.st_qy.ephemeral_keys.wakeQY4("ek_1")


class FieldToField:
    def __init__(self, key):
        # QY5/QY6 (positive): field-to-field chained — both fields consume.
        self.stf_qy = self.stf_alias_qy = stripe.StripeClient(key)
        self.stf_qy.country_specs.wakeQY5("US")
        self.stf_alias_qy.balance_transactions.wakeQY6("txn_1")


class DerivedTrailer:
    def __init__(self, key):
        # QY7 (negative): derived-object trailer after the balanced close —
        # neither name holds the client (Loop 338 verdict carries over).
        self.dv_qy = dw_qy = stripe.StripeClient(key).charges
        self.dv_qy.dropQY7("ch_1")


class ThreeTargets:
    def __init__(self, key):
        # QY8 (negative): 3+ targets are an honest skip (AST track).
        self.a_qy = b_qy = c_qy = stripe.StripeClient(key)
        self.a_qy.dropQY8("x_1")


DOC = """
prose lookalike (negative): a chained self-field assignment quoted in a
docstring or triple-quoted string must never mint —
self.sx_qy = cx_qy = stripe.StripeClient(key)
self.sx_qy.forwarding.dropQY9("fr_1")
"""
