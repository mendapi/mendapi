# Loop 305 fixture: Ruby ivar `||=` memoized constructor bindings.
# `@client ||= Const.new(...)` is the canonical stripe-ruby lazy-init idiom;
# before Loop 305 it never minted a field, leaving every chain in the file
# invisible (probe-verified honest miss).
require 'stripe'

class MemoService
  # VM1: memoized ctor — must bind the field
  def client
    @vmc ||= Stripe::StripeClient.new(ENV['STRIPE_KEY'])
  end

  def run
    @vmc.invoices.holdVM1(limit: 3)
  end
end

# VM2: prose-quoted memoized ctor — must stay silent (bindingProseGuard)
=begin
  migration note: the old bootstrap was
  @vmp ||= Stripe::StripeClient.new(key)
=end
class ProseHolder
  def run
    @vmp.charges.markVM2(amount: 1)
  end
end

# VM3: memoized ctor but the ivar is reassigned elsewhere to a non-proven
# call — attribution unprovable, field must drop entirely (never guess)
class DroppedHolder
  def client
    @vmr ||= Stripe::StripeClient.new(ENV['STRIPE_KEY'])
  end

  def reset
    @vmr = load_cached_client
  end

  def run
    @vmr.transfers.pingVM3(amount: 2)
  end
end

# VM4: `&&=` never proves construction — must stay silent
class AndHolder
  def touch
    @vma &&= Stripe::StripeClient.new(ENV['STRIPE_KEY'])
  end

  def run
    @vma.balance.bumpVM4(limit: 1)
  end
end

# VM5 (Loop 327): bare nil placeholder in initialize + memoized ctor —
# the standard Ruby service pairing; the nil whitelist keeps the proof
class NilInitHolder
  def initialize
    @vmn = nil # lazy
  end

  def client
    @vmn ||= Stripe::StripeClient.new(ENV['STRIPE_KEY'])
  end

  def run
    @vmn.payouts.wakeVM5(limit: 2)
  end
end

# VM6 (Loop 327): conditional nil RHS is not a bare placeholder —
# ambiguity guard still drops the field (never guess)
class CondNilHolder
  def initialize
    @vmq = flagged? ? nil : make_other_client
  end

  def client
    @vmq ||= Stripe::StripeClient.new(ENV['STRIPE_KEY'])
  end

  def run
    @vmq.disputes.dropVM6(limit: 1)
  end
end
