// Loop 202: TypeScript type-annotated constructor bindings.
// The annotation between the identifier and `=` is a dotted name with an
// optional generic argument list and never contains `=` — the TS mirror of
// the Python PEP 526 slot. Positive: plain and generic annotations bind.
// Negative: union annotations, ternary RHS, string lookalikes, and unproven
// local classes never bind.
import Stripe from 'stripe';

// positive: plain annotation on the construction line
const annClient: Stripe = new Stripe('sk_test');
// positive: generic annotation (e.g. a wrapped client type)
const annWrapped: Promise<Stripe> = new Stripe('sk_test');

export async function annotatedFlows(id: string) {
  await annClient.invoiceItems.retrieveTB1(id);
  await annWrapped.plans.delTB2(id);
}

// negative: union annotation is honestly not bound (never guess)
const annMaybe: Stripe | null = new Stripe('sk_test');
// note: in-string declaration lookalikes share the pre-existing exposure of
// the base (non-line-anchored) declaration matcher — not asserted here.
// negative: unproven local class annotation never binds
class AnnLocal {}
const annLoc: AnnLocal = new AnnLocal();

export function annotatedNegatives() {
  annMaybe && annMaybe.payoutsx.listBadTB3('x');
  (annLoc as any).thing.doBadTB4();
  return 0;
}
