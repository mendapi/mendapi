// Student-loan liabilities helpers built on plaid-node. The repayment plan
// literal for the interest-only plan type changed its serialized form in
// 44.0.0 (StudentRepaymentPlanType now matches the live API value).
const { PlaidApi } = require('plaid');

function isInterestOnlyPlan(loan) {
  // repayment_plan.type carries the raw StudentRepaymentPlanType wire value.
  return loan.repayment_plan && loan.repayment_plan.type === 'interest-only';
}

function describePlan(loan) {
  switch (loan.repayment_plan.type) {
    case 'interest-only':
      return 'Payments cover interest only until the deferment window ends.';
    case 'standard':
      return 'Fixed payments over the loan term.';
    default:
      return 'See servicer for plan details.';
  }
}

module.exports = { isInterestOnlyPlan, describePlan, PlaidApi };
