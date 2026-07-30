# Ruby consumer: require lines are the binding proof, the SDK's documented
# top-level constant is the chain root. Proven forms inventoried:
#   1. direct constant chains:  Stripe::Charge.create(...)
#   2. instances from constructors: client = Twilio::REST::Client.new(...)
#   3. paren-less chains whose first arg token is an unambiguous starter
#      (keyword arg / symbol / string): Stripe::Subscription.cancel sub: id
# A constant chain in this comment (Stripe::Refund.create()) must never count,
# and zero-arg / bare-identifier paren-less mentions stay uninventoried
# (AST track — see lib/rbneg.rb).
require 'stripe'
require 'twilio-ruby'
require_relative 'stripe' # local file, must not bind anything

Stripe.api_key = ENV['STRIPE_SECRET_KEY']

def charge_customer(cust_id, amount)
  Stripe::Charge.create(customer: cust_id, amount: amount, currency: 'usd')
end

# Loop 194: paren-less constant-chain calls with an unambiguous argument
# starter (keyword arg / symbol / string literal) are inventoried; bare
# mentions and bare-identifier args below in this file must never count.
def cancel_subscription(sub_id)
  Stripe::Subscription.cancel sub_id: sub_id
end

def parenless_never_binds_without_arg_proof(amount)
  Stripe::Refund.create amount   # bare identifier arg - prose-ambiguous
  Stripe::Payout.list            # zero-arg mention - never a proven call
end

# Loop 195: in-string and comment-tail lookalikes of the PAREN form must
# never count — only the real code before the `#` marker binds here.
def capture_with_noise(ch_id)
  msg = "fallback: run Stripe::Payout.list(limit: 3) by hand"
  log('deprecated path: Stripe::Refund.create(amount) was removed')
  Stripe::Charge.capture(ch_id) # like Stripe::Refund.create(x) but newer
end

client = Twilio::REST::Client.new(ENV['TWILIO_ACCOUNT_SID'], ENV['TWILIO_AUTH_TOKEN'])

# Loop 199: paren-less constructor spellings of the same instance proof.
# Zero-arg EOL (the stripe-ruby v8+ quickstart form) and unambiguous-starter
# arg forms bind; a bare-identifier arg trailer stays on the AST track.
sclient = Stripe::StripeClient.new

def list_invoices(sclient)
  sclient.invoices.listPL9(limit: 3)
end

kclient = Stripe::StripeClient.new api_version: '2026-01-01'

def cancel_payout(kclient, id)
  kclient.payouts_pl.cancelPL9(id)
end

bad_client = Stripe::StripeClient.new cfg # bare identifier arg - never binds

def never_counts(bad_client)
  bad_client.refunds_pl.createPL9(1)
end

def send_sms(client, to, body)
  client.messages.create(to: to, from: '+15550001111', body: body)
end

# Loop 211: instance variables — `@ivar = Const.new` inside initialize is the
# canonical Ruby service-class client holder. Same constructor proof as the
# local-variable form above; file-level ambiguity guard drops any ivar that
# is written anywhere else in the file. Consumer chains need call parens and
# two segments after the field.
class BillingServiceIV
  def initialize
    @sc = Stripe::StripeClient.new
  end

  def confirm_intent(id)
    @sc.payment_intents.confirmIV1(id)
  end
end

class KeywordCtorIV
  def initialize
    @kc = Stripe::StripeClient.new api_version: '2026-01-01'
  end

  def capture_charge(a)
    @kc.charges.captureIV2(a)
  end
end

class ReassignedIV
  def initialize
    @rc = Stripe::StripeClient.new
  end

  def reset
    @rc = build_local # non-proof write -> whole field drops
  end

  def use
    @rc.invoices.listIV3(1)
  end
end

class ThinAndNoiseIV
  def initialize
    @tn = Stripe::StripeClient.new
  end

  def use
    @tn.pingIV4(1) # one segment after field - attribution too thin
    msg = "docs: @tn.charges.createIV5(1) by hand"
    # @tn.charges.createIV6(1) commented out
    @tn.subscriptions.cancelIV7(1) # real code before a comment tail binds
  end
end


def parenless_never_counts
  # bare constant mention / paren-less call — deliberately not inventoried
  Twilio::REST::Client
end
