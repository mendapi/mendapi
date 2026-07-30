# Loop 210 fixture: Python setter/method injection
# (`def set_client(self, c: OpenAI): self.c = c` — type-annotated param
# hand-off, the Python mirror of the PHP (Loop 207) / TS (Loop 208) setters)
from openai import OpenAI
import stripe


class InjectedAI:
    # positive: pyClass-annotated param, pure hand-off
    def set_client(self, oc: OpenAI):
        self.oc = oc

    def ask(self, q):
        return self.oc.chat.completions.confirmPJ1(model="gpt", messages=q)


class InjectedStripe:
    # positive: depth-1 module-attribute annotation, annotated hand-off slot
    def set_stripe(self, scl: stripe.StripeClient):
        self.scl: stripe.StripeClient = scl

    def bill(self, cid):
        return self.scl.payment_intents.capturePJ2(cid)


class ReusedParam:
    # negative: same param name in two single-line signatures — drop
    def set_x(self, rp: OpenAI):
        self.x = rp

    def set_y(self, rp):
        self.y = rp

    def use(self):
        return self.x.chat.completions.confirmPJ3(model="x")


class DefaultedParam:
    # negative: defaulted param never matches (annotation must end at , or ))
    def set_d(self, dp: OpenAI = None):
        self.d = dp

    def use(self):
        return self.d.chat.completions.confirmPJ4(model="x")


class RewrittenParam:
    # negative: param written elsewhere in the file — drop
    def set_r(self, wp: stripe.StripeClient):
        wp = None
        self.r = wp

    def use(self):
        return self.r.payment_intents.capturePJ5(1)


class UntypedParam:
    # negative: untyped param never binds
    def set_u(self, up):
        self.u = up

    def use(self):
        return self.u.charges.confirmPJ6(1)


# negative: comment lookalike never binds
# def set_z(self, zp: OpenAI): self.z = zp; self.z.chat.completions.confirmPJ7(model="x")


# --- Loop 214: inline suite positions for setter hand-offs ---
# (single-line def suite / `;` second statement — the setter mirror of the
# Loop 213 inline ctor positions)
class InlineSetterAI:
    # positive: single-line def suite hand-off (pyClass annotation)
    def set_client(self, ioc: OpenAI): self.ioc = ioc

    def ask(self, q):
        return self.ioc.chat.completions.confirmIJ1(model="gpt", messages=q)


class InlineSetterStripe:
    # positive: `;` second-statement hand-off (depth-1 module-attribute annotation)
    def set_stripe(self, iscl: stripe.StripeClient): self.tag = "x"; self.iscl = iscl

    def bill(self, cid):
        return self.iscl.payment_intents.captureIJ2(cid)


class InlineSetterRewritten:
    # negative: inline hand-off but param rewritten elsewhere — drop
    def set_r(self, irc: stripe.StripeClient): self.ir = irc

    def reset(self):
        irc = None

    def use(self):
        return self.ir.payment_intents.captureIJ3(1)


class InlineSetterString:
    # negative: in-string inline lookalike never binds (prose guard)
    def doc(self):
        return "def set_g(self, igc: OpenAI): self.ig = igc"

    def use(self):
        return self.ig.chat.completions.confirmIJ4(model="x")


# negative: commented inline hand-off never binds (prose guard)
# def set_h(self, ihc: OpenAI): self.ih = ihc
class InlineSetterComment:
    def use(self):
        return self.ih.chat.completions.confirmIJ5(model="x")


# --- Loop 230: multi-line (wrapped) def signatures ---
# (Black/PEP 8 wraps any signature with several params onto one param per
# line — the Python mirror of the TS Loop 227 / PHP Loop 222 wrapped
# signatures; balanced-paren walk + scrub judgment)
class WrappedSetterAI:
    # positive: wrapped def signature, pyClass annotation
    def set_client(
        self,
        wpc: OpenAI,
    ):
        self.wpc = wpc

    def ask(self, q):
        return self.wpc.chat.completions.confirmWP1(model="gpt", messages=q)


class WrappedSetterStripe:
    # positive: wrapped def signature with return annotation, depth-1
    # module-attribute annotation
    def set_stripe(
        self,
        wps: stripe.StripeClient,
    ) -> None:
        self.wps = wps

    def bill(self, cid):
        return self.wps.payment_intents.captureWP2(cid)


class WrappedCommentLookalike:
    # negative: commented param inside a wrapped signature never binds
    def set_c(
        self,
        # wpn: OpenAI,
        other,
    ):
        self.wpn = other

    def use(self):
        return self.wpn.chat.completions.retrieveWP3(model="x")


class WrappedStringDefault:
    # negative: annotation lookalike inside a string default never binds
    def set_s(
        self,
        label="wpd: OpenAI",
        wpd=None,
    ):
        self.wpd = wpd

    def use(self):
        return self.wpd.chat.completions.reverseWP4(model="x")


class WrappedDictDefault:
    # negative: dict-default members spell like typed params but never are
    def set_d(
        self,
        cfg={"wpe": OpenAI},
        wpe=None,
    ):
        self.wpe = wpe

    def use(self):
        return self.wpe.chat.completions.retrieveWP5(model="x")
