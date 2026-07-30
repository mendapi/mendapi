# Ruby cbase-qualified (leading `::`) constructor RHS bindings (Loop 335).
# Inside modules/engines, `::Stripe::StripeClient.new(key)` is the defensive
# spelling that escapes lexical-scope shadowing — the SAME top-level constant
# as `Stripe::StripeClient` (require "stripe" defines ::Stripe), so the
# construction proof and binding strength are identical across all holder
# spellings. A namespaced qualifier (`Foo::Stripe...`) must never match.
require "stripe"

# CB1: local holder with cbase-qualified RHS — binds.
cb_client = ::Stripe::StripeClient.new(ENV["CB_KEY"])
cb_client.charges.wakeCB1(amount: 100)

# CB2: constant holder with cbase-qualified RHS — binds.
CB_CLIENT = ::Stripe::StripeClient.new(cb_key)
CB_CLIENT.payment_links.wakeCB2("plink_1")

# CB3: ivar holder with cbase-qualified RHS — binds.
class CbService
  def initialize
    @cb_sc = ::Stripe::StripeClient.new(cb_key)
  end

  def run
    @cb_sc.shipping_rates.wakeCB3("shr_1")
  end
end

# CB4: a foreign-namespace qualifier is NOT the top-level constant —
# `Foo::Stripe` could be anything; never binds, consumer stays silent.
cb_other = Foo::Stripe::StripeClient.new(cb_key)
cb_other.charges.dropCB4(amount: 1)

# CB5: prose lookalikes with the cbase spelling never mint a proof.
CB_DOC = <<~TEXT
  cb_ghost = ::Stripe::StripeClient.new(key)
  cb_ghost.charges.dropCB5(amount: 2)
TEXT
# cb_nope = ::Stripe::StripeClient.new(key)
# cb_nope.charges.dropCB5b(amount: 3)
