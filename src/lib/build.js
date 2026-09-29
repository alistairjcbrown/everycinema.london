// The instant this build ran, stamped into every page's footer so a reader can
// see how fresh the deployed data is. Captured once at module load rather than
// per page, so all ~350 pages in a build report the same moment. Shown in London
// time with the zone spelled out, since a bare time is ambiguous across BST/GMT.
export const builtAt = new Date();

export const builtAtLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  // spelled out as components rather than dateStyle/timeStyle, which Intl
  // refuses to combine with timeZoneName
  timeZoneName: "short",
}).format(builtAt);
