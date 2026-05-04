import { format } from "date-fns";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

function toIST(date: Date | string | number): Date {
  const d = new Date(date);
  return new Date(d.getTime() + IST_OFFSET_MS);
}

export function formatTimeIST(date: Date | string | number): string {
  return format(toIST(date), "hh:mm:ss a");
}

export function formatDateTimeIST(date: Date | string | number): string {
  return format(toIST(date), "MMM dd, hh:mm a");
}

export function formatDateIST(date: Date | string | number): string {
  return format(toIST(date), "MMM dd, yyyy");
}
