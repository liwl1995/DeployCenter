export type DateRange = { from: string; to: string };
export function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** 按本地日历计算包含今天的区间，避免跨月和夏令时导致少一天。 */
export function recentDates(days: number, now = new Date()): DateRange {
  return {
    from: localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1)),
    to: localDateKey(now),
  };
}
export function withinDateRange(date: string, range: DateRange) {
  if (!range.from && !range.to) return true;
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    (!range.from || date >= range.from) &&
    (!range.to || date <= range.to)
  );
}
