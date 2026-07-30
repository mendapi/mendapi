# Negative control (Loop 302): a clean repo whose only provider-looking
# text lives inside Ruby percent-literal bodies. None of it may detect.
MIGRATION = %q(
  Before the upgrade the app used:
    require 'stripe'
    Stripe.api_key = ENV['STRIPE_KEY']
  Replace with the new client per the migration guide.
)

LEGACY = %Q{
  legacy bootstrap:
  require "openai"
  client = OpenAI::Client.new(access_token: ENV["OPENAI_API_KEY"])
}

WORDS = %w[alpha beta (gamma) delta]

def unrelated(total, count)
  total % count
end
