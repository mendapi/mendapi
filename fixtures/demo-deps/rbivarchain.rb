# Chained assignment with @ivar targets (Loop 360): Ruby chained assignment
# binds EVERY target to the same RHS value — the field-target twin of the
# local/constant chained forms (rbchainasgn.rb) and the Ruby cell of the
# field-target chained matrix (PHP Loop 352 / Python Loop 358 / JS Loop 359).
# NOTE: ivar/var names are unique per class — the file-level ambiguity guard
# drops any name assigned more than once in a file (correct behaviour; the
# fixture design must respect it, Loop 358 lesson).
require "stripe"

class UvBillingA
  def initialize(key)
    # field-first: both names hold the client
    @sc_ua = client_ua = Stripe::StripeClient.new(key)
    @sc_ua.invoiceitems.wakeQU1("ii_1")
    client_ua.application_fees.wakeQU2("fr_1")
  end
end

class UvBillingB
  def initialize(key)
    # var-first: both names hold the client
    client_ub = @sc_ub = Stripe::StripeClient.new(key)
    client_ub.usage_records.wakeQU3("ur_1")
    @sc_ub.login_links.wakeQU4("ll_1")
  end
end

class UvBillingC
  def initialize(key)
    # field-to-field: both fields hold the client
    @sc_uc = @alias_uc = Stripe::StripeClient.new(key)
    @sc_uc.source_transactions.wakeQU5("st_1")
    @alias_uc.bank_accounts.wakeQU6("ba_1")
  end
end

class UvBillingD
  def initialize(key)
    # derived trailer: the chain holds a RESOURCE, not the client — neither
    # name may bind (drop side, Loop 337 ruling)
    @dv_ud = dw_ud = Stripe::StripeClient.new(key).charges
    @dv_ud.retrieve.dropQU7("ch_1")
    dw_ud.list.dropQU7("ch_2")
  end
end

class UvBillingE
  def initialize(key)
    # 3-target chain: structural fail (slot after the second `=` must be the
    # proven constant root) — honest skip, AST track
    @a_ue = b_ue = c_ue = Stripe::StripeClient.new(key)
    @a_ue.transfers.dropQU8("tr_1")
    b_ue.reviews.dropQU8("rv_1")
  end
end

class UvBillingF
  # prose control: the chained ivar line lives in a heredoc — never mints
  DOC = <<~TXT
    @sc_uf = client_uf = Stripe::StripeClient.new(key)
    @sc_uf.refunds.dropQU9("re_1")
  TXT
end
