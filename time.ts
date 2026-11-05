/**
 * Local-calendar helpers shared by the ledger.
 *
 * Days are the ledger's unit: the index stores usage per local day, ranges are
 * whole local days, and the trend draws one bar per local day. A day key is a
 * stable `YYYY-MM-DD` string, so ranges and comparisons are plain string
 * ordering — no timestamps, no offsets, no time zone objects leaking into the
 * aggregation.
 */

/** `YYYY-MM-DD` in the machine's local time zone: the ledger's day key. */
export function localDay(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Shift a day key by whole days. */
export function addDays(day: string, delta: number): string {
	const [year, month, date] = day.split("-").map(Number);
	// Noon keeps daylight-saving transitions from landing on the neighbouring
	// date: a midnight timestamp can be skipped or repeat, noon never is.
	return localDay(new Date(year as number, (month as number) - 1, (date as number) + delta, 12));
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : value.toString();
}
