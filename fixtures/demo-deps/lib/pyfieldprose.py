# Fixture: instance-field constructor lines quoted inside multi-line prose
# containers (docstrings / triple-quoted constants) must never mint a
# pySelfFields entry — Loop 297 bindingProseGuard wiring on the two
# Python instance-field matchers. Mirrors goinstprose.go / jsinstprose.js.
import stripe
from openai import OpenAI


def migration_notes():
    """Migration guide — legacy bootstrap (do not use):

    self.sc = stripe.StripeClient(key)

    All calls previously went through self.sc.
    """
    return None


LEGACY_DOC = '''old init:
self.oc = OpenAI(api_key=key)
'''


class Consumer:
    def __init__(self, sc, oc):
        # plain injected params — no proven constructor anywhere real
        self.holder = (sc, oc)

    def run_pd1(self):
        # PD1: field named only inside the docstring above — must be silent
        return self.sc.coupons.holdPD1("c_1")

    def run_pd2(self):
        # PD2: field named only inside the triple-quoted constant — silent
        return self.oc.chat.completions.markPD2()


class Real:
    def __init__(self, key):
        # PD3 control: real constructor at statement start still binds
        self.rc = stripe.StripeClient(key)

    def go(self):
        return self.rc.coupons.pingPD3("c_2")
