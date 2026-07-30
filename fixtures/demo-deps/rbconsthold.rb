# Ruby constant-holder client bindings (Loop 333).
# `STRIPE_CLIENT = Stripe::StripeClient.new(...)` at script/initializer level
# is the canonical Rails `config/initializers/stripe.rb` holder. The target
# being a CONSTANT (uppercase) is the same statement shape and RHS proof as a
# lowercase local — binding strength identical. Negatives must stay silent.
require "stripe"

# KH1: plain `=` constant holder — binds.
PAY_CLIENT = Stripe::StripeClient.new(ENV["KH_KEY"])
PAY_CLIENT.mandates.wakeKH1(id: "mdt_1")

# KH2: `||=` reload-safe initializer form — binds.
CACHED_SC ||= Stripe::StripeClient.new(kh_key)
CACHED_SC.terminal.locations.wakeKH2("tml_1")

# KH3: namespaced constant target never matches the statement anchor
# (`Billing::KHCLIENT` — first identifier is followed by `::`, not `=`),
# so the bare short name below carries no proof — silent.
Billing::KHCLIENT = Stripe::StripeClient.new(kh_key)
KHCLIENT.charges.dropKH3(amount: 1)

# KH4: factory RHS is not a proven construction — silent.
KH_FACTORY = build_kh_client(kh_key)
KH_FACTORY.charges.dropKH4(amount: 2)

# KH5: heredoc body is prose — never mints a constant proof.
KH_DOC = <<~TEXT
  KH_GHOST = Stripe::StripeClient.new(key)
  KH_GHOST.charges.dropKH5(amount: 3)
TEXT

# KH6: comment lookalike — silent.
# KH_NOPE = Stripe::StripeClient.new(key)
# KH_NOPE.charges.dropKH6(amount: 4)

# KH7 (Loop 334): both-arms ternary with a CONSTANT target — binds.
# The test/live-key idiom at initializer level; whichever arm wins, the
# constant holds a proven construction.
MODE_CLIENT = kh_test? ? Stripe::StripeClient.new(kh_tk) : Stripe::StripeClient.new(kh_lk)
MODE_CLIENT.billing_portal.configurations.wakeKH7(id: "bpc_1")

# KH8: ternary whose else arm is `nil` — not both-arms, silent (AST track).
HALF_CLIENT = kh_test? ? Stripe::StripeClient.new(kh_tk) : nil
HALF_CLIENT.charges.dropKH8(amount: 5)

# KH9: namespaced ternary target never proves the bare short name — silent.
Billing::KHTERN = kh_test? ? Stripe::StripeClient.new(kh_tk) : Stripe::StripeClient.new(kh_lk)
KHTERN.charges.dropKH9(amount: 6)
