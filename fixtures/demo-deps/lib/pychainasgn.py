"""Chained-assignment binding fixture (Loop 348).

Python chained assignment (`a = b = Ctor(k)`) binds every target to the
same RHS value — both names hold the constructed client. Two-target forms
bind; 3+ targets and prose lookalikes stay silent.
"""

import stripe
from openai import OpenAI


def two_target_class(key):
    # QZ1 (positive): pyClass chained assignment — both names consume.
    oc = shared = OpenAI(api_key=key)
    oc.audio.wakeQZ1(input="x")
    shared.uploads.wakeQZ2(purpose="assistants")


def two_target_module(key):
    # QZ3 (positive): pyModule depth-1 chained assignment — both names consume.
    sc = client = stripe.StripeClient(key)
    sc.climate.wakeQZ3("ord_1")
    client.entitlements.wakeQZ4("feat_1")


def derived_trailer(key):
    # CB5 (negative): derived-object trailer after the balanced close —
    # neither name holds the client (Loop 338 verdict carries over).
    dv = dw = stripe.StripeClient(key).charges
    dv.dropQZ5("ch_1")
    dw.dropQZ6("ch_2")


def three_targets(key):
    # QZ7 (negative): 3+ targets are an honest skip (AST track).
    a = b = c = stripe.StripeClient(key)
    a.dropQZ7("x_1")


DOC = """
prose lookalike (negative): a chained assignment quoted in a docstring or
triple-quoted string must never mint an instance —
sx = cx = stripe.StripeClient(key)
sx.forwarding.dropQZ8("fr_1")
"""
