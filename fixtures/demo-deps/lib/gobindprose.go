// Loop 291: Go binding prose fixture. The Go import-binding matcher used to
// read the whole file as code — an import line quoted inside a block comment
// or a raw-string body (migration notes are the dominant carrier) minted a
// phantom binding, and a same-named LOCAL variable then had its entire call
// surface falsely attributed to the SDK.
package ledger

import (
	stgo "github.com/stripe/stripe-go/v76"
)

/*
GB1: migration notes quoting the old import form —
import ledgerx "github.com/stripe/stripe-go/v76"
must never mint a binding for the local `ledgerx` below.
*/

var docGB = `
GB2: raw-string usage docs quoting a subpackage import:
charge "github.com/stripe/stripe-go/v76/charge"
`

// GB3: `ledgerx` is a plain local parameter — with the phantom comment
// binding above it would be misattributed to stripe.
func TallyGB(ledgerx LocalLedger) error {
	return ledgerx.Meter.bumpGB3(1)
}

// GB4: `charge` is a local too — the raw-string subpackage quote above must
// not bind it.
func CountGB(charge LocalLedger) error {
	return charge.Meter.holdGB4(2)
}

// GB5: the real import still binds — control.
func RealGB() error {
	return stgo.MendGB5(3)
}
