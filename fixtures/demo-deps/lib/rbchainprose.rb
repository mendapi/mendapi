require "stripe"

# rbchainprose.rb — Loop 328 gold fixture: prose guard on instance-rooted
# chains. A local instance proven by the constructor pass must never bind a
# chain that sits inside a string literal, a comment tail, or a
# non-interpolated heredoc body; a chain inside a `#{ }` interpolation slot
# is a genuine call site and still binds.

szc = Stripe::StripeClient.new(ENV["STRIPE_KEY"])

# real call: binds
szc.charges.wakeRZ1({ amount: 100 })

# string literal quoting a chain: silent
usage = "run szc.refunds.dropRZ2('re_1') to refund"

# comment tail quoting a chain: silent
szc.charges.wakeRZ1({ amount: 200 }) # or szc.payouts.dropRZ3({}) later

# non-interpolated heredoc body quoting a chain: silent
doc = <<~'TXT'
  szc.disputes.dropRZ4({}) closes the dispute
TXT

# interpolation slot: a genuine call site, binds
puts "balance: #{szc.balance.wakeRZ5().available}"
