// Jalali (Solar Hijri) <-> Gregorian conversion.
//
// The arithmetic is the well-known `jalaali-js` algorithm by Behrang Noruzi
// Niya (MIT licensed, https://github.com/jalaali/jalaali-js). It is
// reimplemented here, unchanged in substance, rather than taken as a
// dependency: Nyra ships with zero runtime dependencies and a four-function
// calendar transform does not justify breaking that. The algorithm is exact for
// the 1178–1633 Jalali range (roughly 1799–2256 CE); outside it, conversion is
// extrapolated and the parser refuses the input instead of guessing.
//
// Only two directions are needed by the reminders subsystem: turn a Jalali
// calendar date a Persian-speaking user typed into a Gregorian date, and label
// a Gregorian date back in Jalali for confirmations.

const JALALI_MIN_YEAR = 1178;
const JALALI_MAX_YEAR = 1633;

// Break years of the 33-year leap cycle table from jalaali-js.
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

const div = function (a, b) { return Math.trunc(a / b); };
const mod = function (a, b) { return a - Math.trunc(a / b) * b; };

/** Leap-year and March-equinox data for a Jalali year. */
function jalCal(jy) {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jm = 0;
  let jump = 0;
  let leap = 0;
  let leapG = 0;
  let march = 0;
  let n = 0;

  if (jy < jp || jy >= BREAKS[bl - 1]) throw new Error("Jalali year out of range: " + jy);

  for (let i = 1; i < bl; i += 1) {
    jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  n = jy - jp;

  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;

  leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;

  march = 20 + leapJ - leapG;

  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;

  return { leap: leap, gy: gy, march: march };
}

/** Julian day number for a Gregorian date. */
function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

/** Gregorian date for a Julian day number. */
function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy: gy, gm: gm, gd: gd };
}

/** Julian day number for a Jalali date. */
export function jalaliToJdn(jy, jm, jd) {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

/** Jalali date for a Julian day number. */
export function jdnToJalali(jdn) {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) return { jy: jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy: jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

/** True when `jm` is a valid Jalali month index (1..12). */
export function isValidJalaliMonth(jm) {
  return Number.isInteger(jm) && jm >= 1 && jm <= 12;
}

/** Month length in the Jalali calendar, honouring the leap cycle. */
export function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  try {
    return jalCal(jy).leap === 0 ? 30 : 29;
  } catch (err) {
    return 29;
  }
}

/** True when the year is inside the exactly-converted range. */
export function isConvertibleJalaliYear(jy) {
  return Number.isInteger(jy) && jy >= JALALI_MIN_YEAR && jy <= JALALI_MAX_YEAR;
}

/** Jalali year a Gregorian date falls in — used to sanity-check a typed year. */
export function gregorianToJalali(gy, gm, gd) {
  return jdnToJalali(g2d(gy, gm, gd));
}

/**
 * Jalali date -> Gregorian { year, month, day }.
 *
 * Returns `null` (never a wrong date) when the year is outside the exact range
 * or the day does not exist in that Jalali month.
 */
export function jalaliToGregorian(jy, jm, jd) {
  if (!isConvertibleJalaliYear(jy)) return null;
  if (!isValidJalaliMonth(jm)) return null;
  if (!Number.isInteger(jd) || jd < 1 || jd > jalaliMonthLength(jy, jm)) return null;
  const g = d2g(jalaliToJdn(jy, jm, jd));
  return { year: g.gy, month: g.gm, day: g.gd };
}
