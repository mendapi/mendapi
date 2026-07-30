require "stripe"

# LF1: bare-local ||= memoized lazy-init — the canonical Ruby idiom
# (`sc ||= Stripe::StripeClient.new(key)`) binds the chain (Loop 329).
sc_lf1 ||= Stripe::StripeClient.new(ENV["STRIPE_KEY"])
sc_lf1.charges.wakeLF1({ amount: 100 })

# LF2: &&= never proves construction — only assigns when already truthy.
sc_lf2 &&= Stripe::StripeClient.new(ENV["STRIPE_KEY"])
sc_lf2.payouts.dropLF2({ amount: 100 })

# LF3: heredoc body quoting the idiom never mints an instance.
DOC_LF3 = <<~TXT
  sc_lf3 ||= Stripe::StripeClient.new(ENV["STRIPE_KEY"])
  sc_lf3.disputes.dropLF3("dp_1")
TXT

# LF4: comment lookalike never binds:
# sc_lf4 ||= Stripe::StripeClient.new(ENV["STRIPE_KEY"])
# sc_lf4.balance.dropLF4

# LF5: non-proven RHS (factory call) never binds.
sc_lf5 ||= make_client_lf(ENV["STRIPE_KEY"])
sc_lf5.topups.dropLF5({ amount: 100 })
