// Go SDK usage fixture: positive sites for Go binding-proof inventory.
package payments

import (
	"fmt"
	"os"

	stripe "github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/charge"
	openai "github.com/sashabaranov/go-openai"
)

func init() {
	stripe.Key = os.Getenv("STRIPE_SECRET_KEY")
}

// Subpackage import: `charge` binds by Go's last-path-segment convention.
func CreateCharge(amount int64) error {
	params := &stripe.ChargeParams{Amount: stripe.Int64(amount)}
	c, err := charge.New(params)
	if err != nil {
		return err
	}
	fmt.Println(c.ID)
	return nil
}

// Constructor instance: client := openai.NewClient(...) binds `client`,
// so client.CreateChatCompletion below is inventoried through the instance.
func Ask(prompt string) error {
	client := openai.NewClient(os.Getenv("OPENAI_API_KEY"))
	resp, err := client.CreateChatCompletion(nil, openai.ChatCompletionRequest{})
	if err != nil {
		return err
	}
	fmt.Println(resp.ID)
	return nil
}

// Package-level `var` singleton — the dominant Go idiom for shared clients.
// Both the var-block entry and the bare assignment bind through the same
// depth-1 pkg.NewXxx proof as the `:=` form.
var (
	sharedAI = openai.NewClient("key-from-env")
)

func AskShared() error {
	_, err := sharedAI.ListModelsVG(nil)
	return err
}

// Negative inside a positive file: comment chains must never count.
// stripe.PaymentIntents.Create(params) — prose only, never a surface.
// var ghost = openai.NewClient("z") — commented declaration never binds.
