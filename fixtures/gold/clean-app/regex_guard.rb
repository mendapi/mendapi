# Negative control (Loop 303): Ruby regex literals carrying provider
# lookalikes must never mint a detection on a clean repo.
module UrlGuards
  def stripe_host?(url)
    url.match?(/api.stripe.com/)
  end

  def openai_route?(path)
    path.gsub(/api.openai.com\/v1/, '') != path
  end

  def anchored?(raw)
    # `#` inside a pattern is pattern content, not a comment opener
    raw.match?(/v1#frag/)
  end

  def classy?(raw)
    # char class with a `/` inside must not close the pattern early
    raw.match?(/[a-z\/]+api.twilio.com/)
  end

  def ratio(amount, count)
    # division stays division — masking must not eat real code after it
    amount / count
  end
end
