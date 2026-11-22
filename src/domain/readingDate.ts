// Old backups could contain a wall-clock time without a zone. Interpret those
// times as UTC everywhere. Firestore already recorded the writer's epoch.
const isoWallTime = /^([+-]\d{6}|\d{4})-(\d\d)-(\d\d)[T ](\d\d:\d\d(?::\d\d(?:\.\d+)?)?)$/i;
const isoDateOnly = /^(?:[+-]\d{6}|\d{4})(?:-\d\d(?:-\d\d)?)?$/;
// Numeric zones in older text formats can use one-digit hours or omit minutes.
// Anchor them to a time, a zone name or whitespace so Jan-02-26 is still a date.
const namedZone = /(?:z|\b(?:ut|utc|gmt|[ecmp][ds]t))(?:\s*\([^)]*\))?$/i;
const numericZone =
  /(?:\b(?:gmt|utc)|:\d{2}(?:\.\d+)?|\s)\s*[+-]\d{1,4}(?::\d{2})?(?:\s*\([^)]*\))?$/i;

export const readingEpoch = (timestamp: string, storedEpoch?: number): number => {
  const value = timestamp.trim();
  const wallTime = isoWallTime.exec(value);
  const zoned = namedZone.test(value) || numericZone.test(value);
  const portable = wallTime
    ? `${wallTime[1]}-${wallTime[2]}-${wallTime[3]}T${wallTime[4]}Z`
    : zoned || isoDateOnly.test(value)
      ? value
      : value + ' GMT';
  const epoch = Date.parse(portable);
  if (storedEpoch === undefined || !Number.isFinite(epoch)) return epoch;
  if (!Number.isSafeInteger(storedEpoch) || !Number.isFinite(new Date(storedEpoch).getTime()))
    return NaN;
  return zoned && storedEpoch !== epoch ? NaN : storedEpoch;
};
