# Negative sites for Ruby SDK binding awareness:
# - a constant chain with NO require proof in this file must never count
# - a same-shaped chain on an unrelated local object must never count
def orphan_charge(amount)
  Stripe::Charge.create(amount: amount)
end

def orphan_parenless(cid)
  # paren-less keyword form with NO require proof - must never count
  Stripe::Subscription.cancel sub_id: cid
end

def unrelated(registry)
  registry.messages.create(body: 'noop')
end
