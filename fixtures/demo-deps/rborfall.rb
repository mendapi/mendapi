# rborfall.rb — Loop 317 gold fixture: Ruby same-operand `||` fallback construction.
# OR1 binds (local), OR2 different operand stays silent, OR3 keyword `or`
# stays silent (precedence trap), OR4 binds (ivar verbose fallback, survives
# the ambiguity guard via ivarProvenIdx), OR5 heredoc quote stays silent.
require 'stripe'

# OR1: local same-operand fallback — must bind.
orfa = orfa || Stripe::StripeClient.new(ENV['STRIPE_KEY'])
orfa.charges.holdOR1(amount: 100)

# OR2: different operand — never binds (AST track).
orfb = other_cache || Stripe::StripeClient.new(ENV['STRIPE_KEY'])
orfb.charges.markOR2(amount: 100)

# OR3: keyword `or` spelling — parses as `(orfc = orfc) or …`, never binds.
orfc = orfc or Stripe::StripeClient.new(ENV['STRIPE_KEY'])
orfc.charges.pingOR3(amount: 100)

class OrFallbackService
  def initialize
    # OR4: ivar verbose fallback — must bind and survive the ambiguity guard.
    @orfd = @orfd || Stripe::StripeClient.new(ENV['STRIPE_KEY'])
  end

  def run
    @orfd.disputes.bumpOR4(charge: 'ch_1')
  end
end

NOTE = <<~DOC
  OR5: prose quoting the idiom must never mint an instance:
  orfe = orfe || Stripe::StripeClient.new(k)
DOC
orfe.charges.flipOR5(amount: 100)
