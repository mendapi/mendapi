# Positive control (Loop 302): percent-literal body quotes the OLD
# bootstrap (must not be sites); real code after the closer must be found,
# and modulo lookalikes must not open a phantom literal.
NOTE = %q(
  old bootstrap:
    require 'stripe'
  the closing paren below ends the note
)
require 'stripe'

Stripe.api_key = ENV['STRIPE_KEY']

count = 10 % 3
label = "row %d" % [count]
