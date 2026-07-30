# Multi-line string state fixture (Loop 279): Ruby strings and `#{ }`
# interpolation slots span lines by grammar. Slot bodies on continuation
# lines are REAL code; string prose after the slot closes is not.
require 'stripe'

# RM1: slot opened on one line, call on the next — must bind
msg = "charged: #{
  Stripe::Charge.retrieveRM1(cid).amount
} cents"

# RM2: prose after the slot closes, still inside the string — must NOT bind
note = "see #{
  amt
} then Stripe::Coupon.deleteRM2(id) docs here"

# RM3: control — plain call after the string closed, must bind
tp = Stripe::Topup.createRM3(amount: 1)

# RM4: nested braces inside a multi-line slot — must bind
lbl = "sum: #{
  h.fetch(:k) { {} }.size + Stripe::Quote.acceptRM4(qid).total
}"

# RM5: heredoc body with a multi-line slot — must bind
report = <<~TXT
  total: #{
    Stripe::Mandate.retrieveRM5(mid).status
  }
TXT

# RM6: column-0 =begin inside an open multi-line string is CONTENT, and the
# lookalike chain inside the string body must NOT bind
blob = "start
=begin
  Stripe::Charge.captureRM6(x)
=end
end of string"

# RM7: code after the multi-line string closes — must bind (state reset)
done = Stripe::Charge.captureRM7(ch)

# RP1: multi-line %q content is prose — lookalike must NOT bind, and
# RP2: code after the literal closes must bind (percent frame carried)
sql = %q(
  select 1 where note = 'Stripe::Coupon.deleteRP1(id)'
)
after = Stripe::Topup.createRP2(amount: 2)

# RP3: interpolation slot on a continuation line of a multi-line %Q is
# real code — must bind; RP4: plain prose on another body line must NOT.
msg = %Q(
  charged: #{Stripe::Quote.acceptRP3(qid).total}
  see Stripe::Mandate.cancelRP4(mid) docs
)

# RP5: multi-line %w word list content is prose — must NOT bind
words = %w(
  Stripe::Charge.captureRP5(x)
)
tail = Stripe::Charge.captureRP6(ch)

# Loop 286: Ruby regex literals — pattern content is prose, `#{}` slots
# inside patterns are code, `#` inside a pattern is not a comment, and an
# unpaired quote inside a pattern must not open a phantom string frame.

# RX1: pattern with a constant-chain lookalike — must NOT bind; the real
# call after it on the same line must bind
m1 = raw.match(/Stripe::Topup.retrieveRX1(x)?/) ; ok1 = Stripe::Charge.retrieveRX6(ch)

# RX2: `#` inside a pattern is pattern content, not a comment — the real
# call after the regex closes must bind
m2 = raw.sub(/foo#bar/, '') ; ok2 = Stripe::Plan.deleteRX2(id)

# RX3: unpaired quote inside a pattern must not open a phantom string —
# the call on the NEXT line must bind
m3 = raw.match(/it's fine/)
ok3 = Stripe::Coupon.cancelRX3(pid)

# RX4: division context — `/` after an operand is NOT a regex; the call
# after both slashes must bind
avg = total / count / 2 ; ok4 = Stripe::Refund.captureRX4(rid)

# RX5: `#{}` interpolation slot inside a pattern is real code — the slot
# call must bind, the pattern lookalike around it must NOT
m5 = /pre#{Stripe::Quote.acceptRX5(qid).total}Stripe::Mandate.retrieveRX7(x)post/

# Loop 288: %r percent-regex character classes — `[...]` suspends delimiter
# counting inside the pattern (regex grammar), so a `}` in a class must not
# pop the frame early and a `{` in a class must not bump nesting depth.

# PC1: class `}` must not close the %r{} early — the pattern tail lookalike
# must NOT bind; PC2: the real call after the pattern closes must bind
pc1 = %r{[^}]*Stripe::Topup.createPC1(x)}
pc2 = Stripe::Coupon.createPC2(a)

# PC3: class `{` must not bump nesting — the frame closes on the real `}`
# and the call on the next line must bind (was whole-file blackout)
pc3 = %r{[{]x}
pc4 = Stripe::Charge.retrievePC3(b)

# PC4: `#{}` interpolation slot inside a %r pattern (outside any class) is
# real code — must bind; the pattern prose around it must NOT
pc5 = %r{pre#{Stripe::Quote.acceptPC4(qid).total}Stripe::Mandate.cancelPC5(x)post}
