// Go negative fixture: no monitored SDK import — same-shaped chains on
// unrelated local objects must never create surfaces, and a blank import
// must never bind a package identifier.
package payments

import (
	_ "github.com/plaid/plaid-go/v20" // blank import: side-effect only, no binding
)

type ledger struct{}

func (l ledger) Charges() ledger    { return l }
func (l ledger) Create(_ int) error { return nil }

// Orphan chain: `stripe` here is a local struct, not a proven package binding.
func Post(amount int) error {
	stripe := ledger{}
	return stripe.Charges().Create(amount)
}
