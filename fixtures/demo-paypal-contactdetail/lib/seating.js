// Office seating chart for the partner-referrals onboarding team. The file
// mentions the PayPal partner-referrals integration (so both file-level
// guards pass), but the `primary` binding below comes off an in-house
// seating row - not a phones[]/addresses[] element chain. The binding is
// dead, so the anchor gate is the ONLY defence: this file must come back
// byte-identical.

function seatLabel(row) {
  const { primary, desk } = row;
  return `partner-referrals onboarding desk ${desk}`;
}

module.exports = { seatLabel };
