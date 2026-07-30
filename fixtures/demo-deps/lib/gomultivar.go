// Loop 357 fixture: Go two-target `var` / bare `=` constructor forms — the
// var/assignment twin of the Loop 356 `:=` verdict. Whether read as a
// multi-value return or a parallel assignment, Go binds the FIRST target to
// the first (or only) result of the first RHS expression — the constructor's
// client — regardless of the second name. Negative cases: `_` first target
// (client discarded), ctor in the SECOND expression of a parallel var, and
// prose-quoted lookalikes.
package payments

import (
	openai "github.com/sashabaranov/go-openai"
)

// positive: package-level two-target var with a named error result
var gvClient, gvInitErr = openai.NewClient("k")

func WakeGV1() error {
	if gvInitErr != nil {
		return gvInitErr
	}
	gvClient.CreateSpeechGV1(nil)
	return nil
}

// positive: bare `=` two-target reassignment of pre-declared names
var gvSc interface{}
var gvScErr error

func WakeGV2() {
	gvSc, gvScErr = openai.NewClient("k")
	_ = gvScErr
	gvSc.ListModelsGV2(nil)
}

// positive: var-block entry with two targets
var (
	gvOc, gvOcErr = openai.NewClient("k")
)

func WakeGV3() {
	_ = gvOcErr
	gvOc.CreateImageGV3(nil)
}

// negative: `_` first target — the client is discarded, never binds
var _, gvDropErr = openai.NewClient("k")

func DropGV4() {
	_ = gvDropErr
}

// negative: ctor in SECOND expression of a parallel var — the first-position
// target is NOT the client (RHS anchor sits right after `=`, honest skip).
// Receiver name is unique in this file so the file-scoped instance map cannot
// resolve it through another binding.
var gvOther, gvHandle = 0, openai.NewClient("k")

func DropGV5() {
	_ = gvOther
	gvHandle.CreateEditGV5(nil)
}

// negative: prose-quoted lookalike never binds
/*
var gvQc, gvQErr = openai.NewClient("k")
gvQc.CreateModerationGV6(nil)
*/

func DropGV6() {}
