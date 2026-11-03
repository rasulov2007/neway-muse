// PHONE: a real phone check, shown through the browser's own message like every other field.
// US/Canada numbers (10 digits, or 11 starting with 1), or a full international number with +.
//
// Verbatim from the design (design/apply/Driver-Application-Mobile.html). Kept in its own module so
// packages/shared/src/hiring/apply.test.ts can run the same input table through this and the
// server's `normalizeApplyPhone`: the two must accept and refuse the same numbers.
export function phoneMessage(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) return "";
  if (value.trim().startsWith("+") && !digits.startsWith("1")) {
    return /^[1-9]\d{7,14}$/.test(digits) ? "" : "Enter the full number with its country code.";
  }
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national) ? "" : "Enter a valid 10-digit phone number.";
}
