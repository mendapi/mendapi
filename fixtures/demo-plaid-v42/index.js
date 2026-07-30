// Demo backend using plaid-node 42.x. Versions 43.0.0 and 44.0.0 renamed the
// products-terminate reason-code wrapper types into a single unified type,
// changed the student repayment plan literal to use a space, and replaced the
// scalar PDF-report request field with a plural array field.
const { Configuration, PlaidApi, PlaidEnvironments, ItemProductsTerminateReasonCode, UserProductsTerminateReasonCode } = require('plaid');

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET } },
}));

async function terminateItemProducts(accessToken) {
  const reasonCode = ItemProductsTerminateReasonCode.UserClosedAccount;
  await plaid.itemProductsTerminate({ access_token: accessToken, products: ['transactions'], reason_code: reasonCode });
}

async function terminateUserProducts(userToken) {
  const reasonCode = UserProductsTerminateReasonCode.UserClosedAccount;
  await plaid.userProductsTerminate({ user_token: userToken, products: ['income_verification'], reason_code: reasonCode });
}

async function downloadVerificationPdf(userToken) {
  const { data } = await plaid.craCheckReportVerificationPdfGet({ user_token: userToken, report_requested: 'VOE' });
  return data;
}

module.exports = { terminateItemProducts, terminateUserProducts, downloadVerificationPdf };
