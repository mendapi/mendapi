# Chained-assignment binding fixture (Loop 350).
#
# Ruby chained assignment (`sc = client = Stripe::StripeClient.new(key)`)
# binds EVERY target to the same RHS value — both names hold the constructed
# client. Two-target forms bind (locals and constants); derived trailers,
# 3+ targets and prose lookalikes stay silent.
require "stripe"

# QR1/QR2 (positive): local two-target chained assignment — both consume.
qr_outer = qr_inner = Stripe::StripeClient.new(key)
qr_outer.tokens.wakeQR1("tok_1")
qr_inner.mandates.wakeQR2("m_1")

# QR3/QR4 (positive): constant + local mixed targets — both consume.
QR_MAIN = qr_fallback = Stripe::StripeClient.new(key)
QR_MAIN.tokens.wakeQR3("tok_2")
qr_fallback.mandates.wakeQR4("m_2")

# QR5/QR6 (negative): derived-object trailer after the balanced close —
# neither name holds the client (Loop 337 verdict carries over).
qr_dv = qr_dw = Stripe::StripeClient.new(key).charges
qr_dv.dropQR5("ch_1")
qr_dw.dropQR6("ch_2")

# QR7 (negative): 3+ targets are an honest skip (AST track).
qr_x = qr_y = qr_z = Stripe::StripeClient.new(key)
qr_x.dropQR7("x_1")

# QR8 (negative): a chained assignment quoted in a heredoc body must
# never mint an instance.
QR_DOC = <<~TEXT
  sx = cx = Stripe::StripeClient.new(key)
  sx.forwarding.dropQR8("fr_1")
TEXT

# QS1/QS2 (positive, Loop 355): paren-less bare `.new` at end of line —
# the stripe-ruby v8 quickstart spelling in chained form. Both consume.
qs_outer = qs_inner = Stripe::StripeClient.new
qs_outer.tokens.wakeQS1("tok_3")
qs_inner.mandates.wakeQS2("m_3")

# QS3 (positive, Loop 355): paren-less ENV argument in chained form.
qs_env = qs_env2 = Stripe::StripeClient.new ENV["STRIPE_KEY"]
qs_env.tokens.wakeQS3("tok_4")

# QS4 (positive, Loop 355): paren-less keyword argument in chained form.
qs_kw = qs_kw2 = Stripe::StripeClient.new api_key: key
qs_kw2.mandates.wakeQS4("m_4")

# QS5 (negative, Loop 355): paren-less bare-identifier trailer stays
# prose-ambiguous — never binds (AST track).
qs_bad = qs_bad2 = Stripe::StripeClient.new some_cfg
qs_bad.tokens.dropQS5("tok_5")

# QS6 (negative, Loop 355): derived trailer on the paren-less chain —
# neither name holds the client.
qs_dv = qs_dw = Stripe::StripeClient.new.charges
qs_dv.dropQS6("ch_3")
