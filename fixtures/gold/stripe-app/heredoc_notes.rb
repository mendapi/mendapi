# Positive control (Loop 301): heredoc body quotes the OLD bootstrap
# (must not be sites); real code after the closer must be found.
NOTE = <<~DOC
  old bootstrap:
    require 'stripe'
  the DOC lookalike below must not terminate early
DOC
require 'stripe'

Stripe.api_key = ENV['STRIPE_KEY']

queue = []
queue << 'ITEM'
shifted = 1 << 2
