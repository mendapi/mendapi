# Loop 332 fixture — Ruby memoized ACCESSOR method binding.
# def client; @client ||= Stripe::StripeClient.new(...); end consumed via
# the METHOD name (paren-less zero-arg call) — the documented stripe-ruby
# lazy-init idiom in Rails helpers / Sinatra apps / rake tasks.
require 'stripe'

# MA1 — multi-line accessor: binds, chain roots on the method name.
def stripe_conn
  @stripe_conn ||= Stripe::StripeClient.new(ENV['STRIPE_KEY'])
end
stripe_conn.mandates.wakeMA1('mnd_1')

# MA2 — single-line accessor form: binds.
def stripe_conn_b; @scb ||= Stripe::StripeClient.new(ENV['STRIPE_KEY']); end
stripe_conn_b.terminal.readers.wakeMA2(location: 'tml_1')

# MA3 — intermediate body line before the memoized construction: the return
# value is still the ivar, but attribution needs an AST — honest skip.
def stripe_conn_c
  audit_access
  @scc ||= Stripe::StripeClient.new(ENV['STRIPE_KEY'])
end
stripe_conn_c.mandates.dropMA3('mnd_2')

# MA4 — parameterized def: a bare `name.chain` consumer would not even be a
# zero-arg call of this method — never binds.
def stripe_conn_d(key)
  @scd ||= Stripe::StripeClient.new(key)
end
stripe_conn_d.mandates.dropMA4('mnd_3')

# MA5 — redefinition ambiguity: a second `def stripe_conn_e` makes the
# return value unprovable — drop.
def stripe_conn_e
  @sce ||= Stripe::StripeClient.new(ENV['STRIPE_KEY'])
end
def stripe_conn_e
  fake_registry_handle
end
stripe_conn_e.mandates.dropMA5('mnd_4')

# MA6 — local shadowing: an assignment to the accessor name makes bare
# `stripe_conn_f.chain` root on the local, not the method — drop.
def stripe_conn_f
  @scf ||= Stripe::StripeClient.new(ENV['STRIPE_KEY'])
end
stripe_conn_f = fetch_other_registry
stripe_conn_f.mandates.dropMA6('mnd_5')

# MA7 — prose lookalike: accessor chains quoted in strings/comments stay
# silent (rbCodePosition consumer guard).
# usage hint: stripe_conn.mandates.dropMA7('mnd_6')
msg = "call stripe_conn.mandates.dropMA7b('mnd_7') to begin"

# MA8 — Loop 343: multi-line accessor whose construction line carries a
# derived-resource trailer — the method returns treasury (a RESOURCE, not
# the client). Binding it would anchor a wrong client.* surface — drop.
def stripe_conn_g
  @scg ||= Stripe::StripeClient.new(ENV['STRIPE_KEY']).treasury
end
stripe_conn_g.mandates.dropMA8('mnd_8')

# MA9 — Loop 343: single-line accessor with a derived chain ending in a
# call — the greedy paren match previously swallowed the chain and BOUND
# the accessor as the client (false attribution) — drop.
def stripe_conn_h; @sch ||= Stripe::StripeClient.new(ENV['STRIPE_KEY']).treasury.retrieve('tr_1'); end
stripe_conn_h.mandates.dropMA9('mnd_9')

# MA10 — Loop 343: value-identity trailer (.freeze) returns the same
# client value — binds.
def stripe_conn_i
  @sci ||= Stripe::StripeClient.new(ENV['STRIPE_KEY']).freeze
end
stripe_conn_i.mandates.wakeMA10('mnd_10')
