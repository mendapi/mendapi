# Python consumer: f-string interpolation slots in endpoint paths must
# normalize to the same {param} placeholder JS template literals get,
# so anchor joins work identically across languages. This file also
# exercises Python SDK module bindings: `import stripe` binds the module
# object as a chain root, so stripe.checkout.sessions.create below must be
# inventoried as an sdk-call surface — while the same chain mentioned in
# this comment (stripe.checkout.sessions.create) must never count, and a
# same-shaped chain on an unrelated local object must never count either.
import os
import requests
import stripe
import plaid as plaid_client


def fetch_attempt(attempt_sid: str):
    return requests.get(
        f"https://api.twilio.com/v2/Attempts/{attempt_sid}",
        auth=(os.environ["TWILIO_ACCOUNT_SID"], os.environ["TWILIO_AUTH_TOKEN"]),
    )


def create_checkout(price_id: str):
    stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
    return stripe.checkout.sessions.create(
        line_items=[{"price": price_id, "quantity": 1}],
        mode="payment",
    )


def link_token(user_id: str):
    # aliased module import: chain root is the alias, surface stays
    # binding-agnostic (`plaid client.link_token.create`).
    return plaid_client.link_token.create({"user": {"client_user_id": user_id}})


def unrelated(registry):
    # same-shaped chain on a local object — must never be inventoried
    return registry.checkout.sessions.create(mode="noop")


# pyModules coverage: providers whose pypi import name differs from the npm
# package name (aws -> boto3, firebase -> firebase_admin) must still be
# detected in Python files — and only in Python files (a JS file importing a
# local './boto3-helper' module must never count; see lib/jsneg.js).
import boto3


def upload(bucket: str, key: str, body: bytes):
    s3 = boto3.client("s3")
    return s3.put_object(Bucket=bucket, Key=key, Body=body)


# from-import class bindings: `from openai import OpenAI` proves the binding
# via the import line; `client = OpenAI(...)` (bare Python assignment, no
# const/new) is a resolvable instance — its chains must be inventoried as
# binding-agnostic sdk-call surfaces. An unproven same-named class from a
# local module (`from localhelpers import OpenAI`-style) never binds because
# only provider module names are consulted.
from openai import OpenAI


def ask(question: str):
    ai = OpenAI()
    return ai.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": question}],
    )


def unrelated_ai(fake):
    # same-shaped chain on an unproven local object — never inventoried
    return fake.chat.completions.create(model="noop", messages=[])


# parenthesized (multi-line) from-import lists: the dominant lint-formatted
# idiom. Aliases and per-line comments inside the block must parse; the
# trailing comma must not produce a phantom binding.
from anthropic import (
    Anthropic,  # sync client
    AsyncAnthropic as AsyncAI,
)


def claude(prompt: str):
    bot = Anthropic()
    return bot.messages.create(model="claude", messages=[{"role": "user", "content": prompt}])


def claude_async():
    # inline constructor chain — the from-import binding proof roots the
    # chain directly (Class().method()), same-line balanced-paren scan;
    # must be inventoried without an intermediate variable
    return AsyncAI().messages.stream(model="claude")


# depth-1 module-attribute construction: the chain root is the proven module
# binding, and exactly one attribute segment is allowed — `client =
# stripe.StripeClient(...)` / `s3 = boto3.client(...)` bind as instances, but
# a deep chain assignment (`sess = stripe.checkout.sessions.create(...)`)
# returns API data, not a client, and must never bind (AST track).
sc = stripe.StripeClient("sk_test_fixture")


def modern_charge(email: str):
    return sc.customers.create(email=email)


sess = stripe.checkout.sessions.create(mode="payment")


def deep_chain_result():
    # `sess` came from a deep module chain — reading it is API data access,
    # never a client chain; must not be inventoried
    return sess.list_line_items()


# Python sub-client alias: a *pure* member expression assigned from a proven
# root re-roots later chains with the aliased prefix (same proof as the JS
# `const charges = stripe.charges` form — no call anywhere on the RHS line,
# so the assigned value cannot be API data).
charges = stripe.charges


def alias_charge(amount: int):
    return charges.create(amount=amount)


# alias-of-alias (transitive re-rooting): every hop is the same line-anchored
# pure-member proof, so hops compose. `co` binds off the proven module and
# `co_sessions` binds off `co` — the chain below must surface with the fully
# accumulated prefix (client.checkout.sessions.retrieve).
co = stripe.checkout
co_sessions = co.sessions


def transitive_alias_counted():
    return co_sessions.retrieve("cs_123")


# Loop 201: PEP 526 annotated assignments — the typed-Python idiom
# (`client: OpenAI = OpenAI(...)`) carries the same line-anchored proof as
# the bare form; the annotation (dotted name, optional subscript) sits
# between identifier and `=` and can never appear in dict literals (no `=`)
# or bare declarations (no RHS).
typed_ai: OpenAI = OpenAI(api_key="k")


def typed_ask(q: str):
    return typed_ai.responses.retrieveTA1(q)


tsc: stripe.StripeClient = stripe.StripeClient("sk_x")


def typed_charge():
    return tsc.subscriptions.cancelTA2("sub_1")


# negative: annotated bare declaration (no RHS) must never bind
pending_ai: OpenAI


def bad_pending():
    return pending_ai.chat.badTA3(model="x")


# negative: dict-literal entry (colon, no `=`) must never bind a key name
TA_REGISTRY = {
    "ai": OpenAI(),
}

# negative: string lookalike of an annotated assignment must never bind
ta_msg = 'ta_fake: OpenAI = OpenAI()'


def bad_fake():
    return ta_fake.chat.badTA4(model="x")


# Loop 231: PEP 572 walrus (assignment-expression) bindings — the same
# construction proof as the bare assignment, only the operator differs.
# Positive: from-import class walrus in an if header
def walrus_ask(key, q):
    if wz_ai := OpenAI(api_key=key):
        return wz_ai.chat.completions.confirmWZ1(model="gpt-4o", messages=q)


# positive: depth-1 module-attribute walrus (parenthesized while header)
def walrus_pay(key, amt):
    while (wz_sc := stripe.StripeClient(key)):
        return wz_sc.payment_intents.captureWZ2(amount=amt)


# negative: deep-chain walrus RHS returns API data, never a client
def walrus_deep():
    if (wz_deep := stripe.checkout.sessions.create(mode="x")):
        return wz_deep.line_items.retrieveWZ3()


# negative: in-string walrus lookalike must never bind (prose guard)
wz_msg = "(wz_fake := OpenAI())"
# negative: commented walrus lookalike — (wz_cmt := OpenAI())


def walrus_negatives():
    wz_fake.chat.completions.reverseWZ4(model="x")
    return wz_cmt.chat.completions.reverseWZ5(model="x")
