# Positive control (Loop 303): a regex literal must not black out real
# code after it — on the same line or below.
module StripeRegexRoutes
  def self.frag?(raw)
    raw.match?(/v1#frag/); key = ENV['STRIPE_SECRET_KEY']
    key
  end
end

require 'stripe'
