// A "nice" ceiling for a chart axis: the smallest of 1, 2, 2.5, 4 or 5 × 10^k that
// is at least the data's maximum, so the top label is a round number the bars
// can be read against rather than whatever the busiest day happened to be.
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 4, 5, 10]) {
    if (step * exp >= value) return step * exp;
  }
  return 10 * exp;
}

const compact = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });
export const axisLabel = (n) => (n >= 10000 ? compact.format(n) : new Intl.NumberFormat("en-GB").format(n));
