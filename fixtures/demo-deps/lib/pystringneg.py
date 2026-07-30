# Loop 273: Python prose masking gold — triple-quoted string bodies,
# single-line string content, and comment tails are prose; lookalike chains
# inside them must never bind. Code after a same-line closing delimiter and
# real code between prose spans must still bind.
import stripe

DOC = """
Example usage (do not run):
    stripe.Charge.createTQ1(amount=100)
"""

NOTE = '''
legacy sample: stripe.Transfer.cancelTQ2(pid)
'''

# single-line string content lookalikes never bind
msg = "call stripe.Refund.createTQ3(charge=cid) here"
alt = 'or stripe.Coupon.deleteTQ4(cid) maybe'

# comment-tail lookalike never binds, code before the `#` still does
bal = stripe.Balance.retrieveTQ5()  # like stripe.Transfer.createTQ6(a=1)

# a quote inside a string must not open a phantom triple — the code after
# this line must still bind
q = "it's fine"
ok1 = stripe.Topup.createTQ7(amount=1)

# same-line close: prose before the closing delimiter, code after it binds
inline = """stripe.Charge.captureTQ8(x)"""; ok2 = stripe.Charge.createTQ9(amount=2)

# only the SAME delimiter closes a triple: the ''' inside this """ body is
# string content, and the body keeps masking until the real close
MIXED = """
contains ''' but stays open
stripe.Refund.cancelTQ10(r)
"""
ok3 = stripe.Coupon.createTQ11(id="c")
