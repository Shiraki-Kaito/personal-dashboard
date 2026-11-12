export const maximumAgendaAccounts = 5;
export const maximumAccountLabelLength = 40;
export function validAccountLabel(value) {
  return (
    typeof value === "string" &&
    value.length <= maximumAccountLabelLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
