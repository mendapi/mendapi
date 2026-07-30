// Internal HR directory service. No PayPal context: reads of birth_date
// and extended name fields on employee records must never be rewritten.
function describe(employee) {
  return {
    born: employee.profile.birth_date,
    full: employee.profile.name.full_name,
    prefix: employee.profile.name.prefix,
    district: employee.profile.address.admin_area_3,
  };
}
module.exports = { describe };
