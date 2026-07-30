// Loop 356 fixture: Go multi-return / parallel `:=` constructor forms.
// The second target of a two-target short declaration is ANY identifier
// (initErr / cerr / e / cfg), not just `err` / `_` — Go binds the FIRST
// target to the constructor's client in both the multi-return and the
// parallel-assignment reading. Negative cases: ctor in the SECOND
// expression of a parallel assignment (first name is not the client),
// and prose-quoted lookalikes.
package payments

import (
	openai "github.com/sashabaranov/go-openai"
)

// positive: named error result (the dominant real-world spelling)
func WakeGM1() error {
	client, initErr := openai.NewClient("k")
	if initErr != nil {
		return initErr
	}
	client.CreateSpeechGM1(nil)
	return nil
}

// positive: short error name
func WakeGM2() {
	c, e := openai.NewClient("k")
	_ = e
	c.ListModelsGM2(nil)
}

// positive: parallel assignment, ctor first — first target holds the client
func WakeGM3() {
	client, retries := openai.NewClient("k"), 3
	_ = retries
	client.CreateImageGM3(nil)
}

// negative: ctor in SECOND expression — first-position target is NOT the
// client, and the matcher's RHS anchor sits right after `:=` (honest skip).
// Receiver name is unique in this file so the file-scoped instance map
// cannot resolve it through another function's legitimate binding.
func DropGM4() {
	limit, handle := 5, openai.NewClient("k")
	_ = limit
	handle.CreateEditGM4(nil)
}

// negative: commented lookalike never binds
func DropGM5() {
	// client, initErr := openai.NewClient("k")
	// client.CreateModerationGM5(nil)
}
