<?php
// Negative control (Loop 300): heredoc/nowdoc bodies are prose containers —
// migration notes quoting an old bootstrap must NOT flag this repo as a
// stripe consumer. Before the phpDoc masker this whole repo turned into a
// false consumer with 150 phantom impacts (probed live).
$migrationNote = <<<NOTE
Before v10 the billing worker used:
use Stripe\StripeClient;
$client = new \Stripe\StripeClient($key);
Replace with the platform gateway wrapper instead.
NOTE;

$upgradeSteps = <<<'STEPS'
1. remove `use OpenAI\Client;` from the worker
2. drop the direct SDK constructor
STEPS;

function renderNotes(string $migrationNote, string $upgradeSteps): string
{
    return $migrationNote . "\n" . $upgradeSteps;
}
