# Loop 309 fixture: Python context-manager construction bindings —
# `with OpenAI(api_key=k) as client:` is the openai-python v1 README's own
# spelling (the client IS a context manager) and the httpx-style SDK idiom.
# Before this loop the with-form minted no instance: every chain under the
# `as` name was an honest miss (a whole service function invisible).
# Guards mirror the bare-assignment form: line anchor, bindingProseGuard
# (docstring/triple-quoted lines also start at column 0 — Loop 308 lesson),
# same-line balanced-paren close, and `as NAME` required.
from openai import OpenAI
import stripe


def real_with():
    # positive control: with-construction binds; the chain must surface
    with OpenAI(api_key="k") as wcc:
        return wcc.chat.completions.holdWC1(model="gpt", messages=[])


def module_attr_with(cid):
    # positive control: depth-1 module-attribute with-form binds
    with stripe.StripeClient("sk") as wcs:
        return wcs.payment_intents.bumpWC4(cid)


def docstring_quoted():
    """Migration note (old form):
    with OpenAI(api_key=key) as wcd:
    """
    wcd = make_local()
    return wcd.chat.completions.markWC2(model="x")


def comment_lookalike():
    # with OpenAI(api_key=key) as wcn:
    wcn = make_local()
    return wcn.chat.completions.pingWC3(model="x")


def multiline_args():
    # honest skip: the call does not close on the with line — no binding
    with OpenAI(
        api_key="k",
    ) as wcm:
        return wcm.chat.completions.dropWC5(model="x")
