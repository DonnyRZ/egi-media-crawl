'use strict';

/**
 * Shared listing-date hint parser for Indonesian news sources.
 *
 * Adapter listings frequently expose human-readable timestamps such as:
 *   - "Kamis, 23 Jul 2026 14:35 WIB"          (detik fixture)
 *   - "Jum'at, 24 Juli 2026 | 07:08 WIB"      (suara fixture / live)
 *   - "Jum'at, 24 Juli 2026 - 14:00 WIB"      (sindonews)
 *   - "24 Jul 2026, 16:36 WIB"                (idn_times)
 *   - "24 Juli 2026 | 11.32 WIB"              (tempo DOM fallback)
 *
 * Plain `new Date(...)` cannot parse those (Indonesian day/month names, weekday
 * prefixes, `|` / `-` separators). Overlap-window stop (`src/core/overlap.js`) and
 * `discovered_urls.published_hint` both need a successful parse, so this lives in
 * core rather than being copy-pasted per adapter.
 *
 * Convention: when the hint has no explicit offset, assume Asia/Jakarta (`+07:00`)
 * — same "no-tz means WIB" rule already used across adapters.
 *
 * Time-only fragments (e.g. suara live `"07:08"` for "today") intentionally return
 * `undefined`; there is no absolute day to anchor without inventing one.
 */

// Full Indonesian month names + common EN/ID abbreviations seen on listing cards.
const MONTH_INDEX = {
  januari: 0,
  februari: 1,
  maret: 2,
  april: 3,
  mei: 4,
  juni: 5,
  juli: 6,
  agustus: 7,
  september: 8,
  oktober: 9,
  november: 10,
  desember: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  jly: 6,
  agu: 7,
  ags: 7,
  aug: 7,
  sep: 8,
  sept: 8,
  okt: 9,
  oct: 9,
  nov: 10,
  des: 11,
  dec: 11,
};

/**
 * @param {number} year
 * @param {number} monthIndex - 0-based
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} [second]
 * @returns {Date|undefined}
 */
function buildWibDate(year, monthIndex, day, hour, minute, second = 0) {
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+07:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * "DD Month YYYY[ ,|-| |]HH[:.]mm[:ss]" with optional weekday prefix and trailing WIB/WITA/WIT.
 * @param {string} text
 * @returns {Date|undefined}
 */
function tryParseIndonesianListing(text) {
  const match = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\D+(\d{1,2})[:.](\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return undefined;
  const [, dayRaw, monthRaw, yearRaw, hourRaw, minuteRaw, secondRaw] = match;
  const monthIndex = MONTH_INDEX[monthRaw.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  return buildWibDate(
    Number(yearRaw),
    monthIndex,
    Number(dayRaw),
    Number(hourRaw),
    Number(minuteRaw),
    secondRaw ? Number(secondRaw) : 0
  );
}

/**
 * "YYYY-MM-DD[ T]HH:mm[:ss]" with no timezone marker (JSON-LD / API no-tz forms).
 * @param {string} text
 * @returns {Date|undefined}
 */
function tryParseNoTzSqlDatetime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return buildWibDate(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), second ? Number(second) : 0);
}

/**
 * @param {string|Date|null|undefined} hint
 * @returns {Date|undefined} parsed instant, or undefined when missing/unparseable.
 */
function parseListingDate(hint) {
  if (!hint) return undefined;
  if (hint instanceof Date) {
    return Number.isNaN(hint.getTime()) ? undefined : hint;
  }
  if (typeof hint !== 'string') return undefined;
  const text = hint.trim();
  if (!text) return undefined;

  // Prefer locale-aware listing forms before native Date so "23 Jul 2026 14:35" is always
  // treated as WIB rather than whichever local TZ the process happens to run under.
  const indonesian = tryParseIndonesianListing(text);
  if (indonesian) return indonesian;

  const noTz = tryParseNoTzSqlDatetime(text);
  if (noTz) return noTz;

  const native = new Date(text);
  return Number.isNaN(native.getTime()) ? undefined : native;
}

/**
 * ISO-string wrapper for `discovered_urls.published_hint` / coreAdapter `tryParseHint`.
 * @param {string|Date|null|undefined} hint
 * @returns {string|undefined} UTC ISO 8601, or undefined if unparseable/absent.
 */
function parseListingDateIso(hint) {
  const parsed = parseListingDate(hint);
  return parsed ? parsed.toISOString() : undefined;
}

module.exports = {
  MONTH_INDEX,
  parseListingDate,
  parseListingDateIso,
};
