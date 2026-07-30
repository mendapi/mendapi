# Multi-line /x regex bodies (Loop 344). A regex opened directly after `=`
# is grammatically unambiguous and its frame carries across lines: binding
# and chain lookalikes inside the pattern body are prose and must never
# mint. `#{ }` interpolation slots inside the pattern stay real code.
require "stripe"

client = Stripe::StripeClient.new(ENV["STRIPE_KEY"])

# body contains a binding lookalike + a consuming chain lookalike — both prose
GUIDE = /
  sc = Stripe::StripeClient.new(api_key)
  sc.crypto.dropMX2(id)
/x

# body contains a direct constant-rooted chain lookalike — prose
SHAPE = /
  Stripe::Charge.retrieve(id).dropMX3
/x

# an interpolation slot inside the pattern is code position — genuine call
PATTERN = /
  ^#{client.radar.wakeMX4(1)}$
/x

# state fully resets after the closed patterns: real code still binds
client.apple_pay_domains.wakeMX1(limit: 1)

# `/` after an operand stays division — the next line is plain code
rate = total / count
client.review.wakeMX6(limit: 1)

# Loop 345: opener after `(` — argument regex carries across lines; the
# binding + chain lookalikes in the body are prose and must never mint
text.gsub!(/
  sc = Stripe::StripeClient.new(api_key)
  sc.crypto.dropMX7(id)
/x, "")

# Loop 345: opener after `,` — second-argument regex carries too
text.scan(1, /
  Stripe::Terminal.dropMX8(amount: 1)
/x)

# an interpolation slot inside an argument pattern is still code position
text.match(/
  ^#{client.tax_ids.wakeMX9(1)}$
/x)

# parenthesised same-line division never opens a carried regex
half = (total / 2)
client.topups.wakeMX10(limit: 1)

# Loop 346: opener after `[` — array-element regex carries across lines; the
# binding + chain lookalikes in the body are prose and must never mint
PATTERNS = [/
  sc = Stripe::StripeClient.new(api_key)
  sc.crypto.dropMX11(id)
/x]

# Loop 346: opener after `{` — hash-literal value regex carries too
RULES = {/
  Stripe::Terminal.dropMX12(amount: 1)
/x => :strip}

# Loop 346: opener after `|` (second pipe of ||) — alternation operand regex
ok = str =~ /simple/ || str =~ /
  api = Stripe::StripeClient.new(api_key)
  api.crypto.dropMX13(id)
/x

# `?/` is a character literal, not a regex opener — next line is plain code
sep = win ? ?/ : ?\\
client.issuing.wakeMX14(limit: 1)

# `:/` is the division symbol, not a regex opener — next line is plain code
total = nums.reduce(:/)
client.early_fraud_warnings.wakeMX15(limit: 1)
