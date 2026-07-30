# Ruby both-arms ternary constructor binding fixture (Loop 314).
# TC1: local both-arms ternary — binds (test/live key idiom).
# TC2: single-arm (`: nil`) — never binds (AST track).
# TC3: comment quoting a ternary hand-off — never binds (statement anchor).
# TC4: ivar both-arms ternary — binds and survives the ambiguity guard.
# TC5: ivar both-arms ternary + non-proven reassignment elsewhere — drops.
require "stripe"

# TC1: whichever arm wins, sc1 holds a proven construction.
sc1 = test_mode ? Stripe::StripeClient.new(tk) : Stripe::StripeClient.new(lk)
sc1.charges.holdRT1(amount: 100)

# TC2: else arm is nil — variable is only sometimes a client. Never bind.
sc2 = test_mode ? Stripe::StripeClient.new(tk) : nil
sc2.charges.markRT2(amount: 100)

# TC3: prose quoting the idiom (migration note) must stay silent:
# sc3 = t ? Stripe::StripeClient.new(a) : Stripe::StripeClient.new(b)
sc3.charges.pingRT3(amount: 100)

class TernaryPay
  def initialize(flag)
    # TC4: ivar both-arms — binds; ternary proof feeds the ambiguity guard.
    @tp4 = flag ? Stripe::StripeClient.new(tk) : Stripe::StripeClient.new(lk)
  end

  def run
    @tp4.subscriptions.bumpRT4(sub_id: "s")
  end
end

class TernaryDrop
  def initialize(flag)
    # TC5: proven ternary write here...
    @tp5 = flag ? Stripe::StripeClient.new(tk) : Stripe::StripeClient.new(lk)
  end

  def reset
    # ...but a non-proven reassignment elsewhere drops the field entirely.
    @tp5 = build_fake_client
  end

  def run
    @tp5.refunds.flipRT5(charge: "c")
  end
end
