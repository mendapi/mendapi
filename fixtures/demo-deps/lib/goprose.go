// Loop 290: Go prose masking fixture. Go previously had NO masker at all —
// lookalike chains inside trailing comments, block-comment bodies,
// interpreted strings and raw strings all minted false surfaces.
package payments

import (
	"fmt"

	stripe "github.com/stripe/stripe-go/v76"
)

// GP1: trailing comment after real code — the prose chain must stay silent
// while the real call on the same line binds.
func RunGP() error {
	res := stripe.MendGP6(1) // legacy: stripe.Mandate.fetchGP1(x) was removed
	fmt.Println(res)
	return nil
}

/* GP2: block-comment body spanning lines —
   stripe.Quote.holdGP2(y) is prose, never a surface. */
func AfterBlockGP() error {
	// GP7: code after the block closer still binds.
	return stripe.MendGP7(2)
}

// GP3: interpreted-string content is prose.
var noteGP = "operators should run stripe.Dispute.markGP3(z) by hand"

// GP4/GP5: raw-string bodies (single-line and multi-line) are prose with no
// escape processing; the closing backtick returns to code.
var usageGP = `run stripe.Topup.sendGP4(w) first`

var helpGP = `Quickstart:
  then call stripe.Coupon.putGP5(v)
before deploying`

// GP8: code after the multi-line raw string closed still binds.
func AfterRawGP() error {
	return stripe.MendGP8(3)
}
