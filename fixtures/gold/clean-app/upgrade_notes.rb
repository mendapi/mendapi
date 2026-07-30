# Negative control (Loop 301): a clean repo whose only provider-looking
# text lives inside Ruby heredoc bodies. None of it may detect.
MIGRATION_NOTE = <<~DOC
  Before the upgrade the app used:
    require 'stripe'
    Stripe.api_key = ENV['STRIPE_KEY']
  Replace with the new client per the migration guide.
DOC

LEGACY = <<-'RAW'
  legacy bootstrap:
  require "openai"
  client = OpenAI::Client.new(access_token: ENV["OPENAI_API_KEY"])
RAW

def unrelated(value)
  value * 2
end
