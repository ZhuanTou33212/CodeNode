/** datetime-local uses wall-clock fields in the device's current time zone. */
export function toLocalDateTimeInput(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return '';
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
