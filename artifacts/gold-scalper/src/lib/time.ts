const IST_TIME: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
};

const IST_DATETIME: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Kolkata",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
};

const IST_DATE: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Kolkata",
  month: "short",
  day: "2-digit",
  year: "numeric",
};

export function formatTimeIST(date: Date | string | number): string {
  return new Date(date).toLocaleString("en-IN", IST_TIME);
}

export function formatDateTimeIST(date: Date | string | number): string {
  return new Date(date).toLocaleString("en-IN", IST_DATETIME);
}

export function formatDateIST(date: Date | string | number): string {
  return new Date(date).toLocaleString("en-IN", IST_DATE);
}
