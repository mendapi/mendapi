// Loop 295: Go instance prose fixture. The Go constructor-instance matchers
// (`:=` and `var/=` forms) used to read the whole file as code — a
// constructor line quoted inside a block comment or a raw-string body
// (migration notes / usage docs) minted a phantom instance, and a same-named
// LOCAL variable then had its entire call surface falsely attributed to the
// SDK. Same carriers Loop 291 closed on the import-binding layer.
package vault

import (
	stgo "github.com/stripe/stripe-go/v76"
)

/*
GI1: migration notes quoting the old constructor form —
	client := stgo.NewClient(key)
must never mint an instance for the local `client` below.
*/

var docGI = `
GI2: raw-string usage docs quoting the var-assignment constructor form:
var sc = stgo.NewClient(cfg)
`

// GI3: `client` is a plain local parameter — with the phantom comment
// instance above it would be misattributed to stripe.
func TallyGI(client LocalVault) error {
	return client.Meter.bumpGI3(1)
}

// GI4: `sc` is a local too — the raw-string constructor quote above must
// not mint an instance for it.
func CountGI(sc LocalVault) error {
	return sc.Meter.holdGI4(2)
}

// GI5: a real constructor still binds — control.
func RealGI() error {
	real := stgo.NewClient("k")
	return real.Coupons.pingGI5(3)
}
