# Fixture (Loop 342): Ruby paren-less constructor with an ENV argument.
# `Stripe::StripeClient.new ENV["STRIPE_KEY"]` is the documented stripe-ruby
# quickstart spelling — ENV is a core global constant, so `ENV[` / `ENV.fetch(`
# right after `.new ` is unambiguous call proof (prose cannot form it).
require "stripe"

# EV1: local holder, ENV bracket arg — binds.
sc = Stripe::StripeClient.new ENV["STRIPE_KEY"]
sc.tax_codes.wakeEV1("txcd_1")

# EV2: constant holder, ENV.fetch arg — binds.
SC_MAIN = Stripe::StripeClient.new ENV.fetch("STRIPE_KEY")
SC_MAIN.webhook_endpoints.wakeEV2(url: "https://x.test")

# EV3: ivar holder, memoized ||= with ENV bracket arg — binds.
@sc ||= Stripe::StripeClient.new ENV["STRIPE_KEY"]
@sc.charges.wakeEV3(amount: 100)

# EV4: bare-identifier argument — prose-ambiguous, never binds (AST track).
sc4 = Stripe::StripeClient.new Rails.application.credentials.stripe_key
sc4.payouts.dropEV4("po_1")

# EV5: prose lookalike in a comment — never mints.
# Stripe::StripeClient.new ENV variables are read at boot; see dropEV5 notes.

# EV6: heredoc body quoting the spelling — never mints.
DOC = <<~TEXT
  sc6 = Stripe::StripeClient.new ENV["STRIPE_KEY"]
  sc6.refunds.dropEV6("re_1")
TEXT
