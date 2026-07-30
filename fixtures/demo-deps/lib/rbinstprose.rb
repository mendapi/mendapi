# Loop 298 gold fixture: Ruby instance/ivar constructor lines quoted inside
# multi-line prose containers must never mint a binding, and same-file
# lookalike names (parameters) must stay silent. Real constructors in the
# same file still bind (control).
require 'stripe'

# RI1: block-comment migration note quoting the old bootstrap — the quoted
# constructor must NOT mint an instance, so the `client` PARAMETER below
# stays unattributed (silent).
=begin
Migration note — previously we bootstrapped like this:
client = Stripe::StripeClient.new(api_key)
=end
def charge_customer(client, amount)
  client.charges.holdRI1(amount)
end

# RI2: heredoc body quoting the old bootstrap — same rule for the `sc`
# parameter below.
UPGRADE_DOC = <<~NOTES
  Old initialization:
  sc = Stripe::StripeClient.new(key)
NOTES
def refund_order(sc, id)
  sc.refunds.markRI2(id)
end

# RI3: ivar constructor quoted in a block comment — must NOT mint a field,
# so the @ac chain below stays silent.
=begin
legacy service class:
@ac = Stripe::StripeClient.new(key)
=end
class AccountSync
  def run
    @ac.accounts.list.pingRI3(3)
  end
end

# RI4: real constructor in the same file still binds (control).
real = Stripe::StripeClient.new(ENV['STRIPE_KEY'])
real.coupons.bumpRI4(1)
