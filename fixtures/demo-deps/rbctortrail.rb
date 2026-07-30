# Ruby constructor trailing-chain adjudication (Loop 337).
# The paren-branch matchers previously stopped at `.new(` and ignored the
# rest of the line — `sc = Stripe::StripeClient.new(k).charges` bound `sc`
# as the CLIENT while it actually holds a derived resource (false
# attribution). Ruling: after the balanced same-line close paren, only a
# chain of value-identity methods (.freeze/.dup/.clone) may follow; any
# other trailer drops the binding (AST track). Paren-less `.new.freeze`
# spellings now bind via the extended EOL trailer.
require "stripe"

# FZ1: paren ctor + .freeze — value-identity trailer, binds.
FZ_CLIENT = Stripe::StripeClient.new(ENV["FZ_KEY"]).freeze
FZ_CLIENT.charges.wakeFZ1(amount: 100)

# FZ2: paren-less ctor + .freeze (previously an honest miss) — binds.
fz_local = Stripe::StripeClient.new.freeze
fz_local.disputes.wakeFZ2("re_1")

# FZ3: ivar ctor + .dup — copy of the client, binds.
class FzService
  def initialize
    @fz_sc = Stripe::StripeClient.new(fz_key).dup
  end

  def run
    @fz_sc.payouts.wakeFZ3("po_1")
  end
end

# FZ4: derived-resource trailer — the var holds charges, NOT the client.
# Binding must drop; the bare consumer chain stays silent (AST track).
fz_res = Stripe::StripeClient.new(fz_key).charges
fz_res.transfers.dropFZ4(amount: 1)

# FZ5: .tap trailer is deliberately not whitelisted (block re-derives) —
# silent.
fz_tap = Stripe::StripeClient.new(fz_key).tap { |c| c.inspect }
fz_tap.charges.dropFZ5(amount: 2)

# FZ6: same-operand || fallback with a derived trailer — silent.
fz_fb = fz_fb || Stripe::StripeClient.new(fz_key).balance
fz_fb.charges.dropFZ6(amount: 3)

# FZ7: multi-line argument list keeps the accepted-as-is behavior — binds.
fz_ml = Stripe::StripeClient.new(
  fz_key
)
fz_ml.terminal.readers.wakeFZ7("tmr_1")

# FZ8: prose lookalike of the freeze spelling — never mints.
FZ_DOC = <<~TEXT
  FZ_GHOST = Stripe::StripeClient.new(key).freeze
  FZ_GHOST.charges.dropFZ8(amount: 4)
TEXT
