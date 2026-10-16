// R5 (H137; the QA round, defect 6, Studio's side): one time format on Studio's page, as the terminal Workbench and the companion
// show it (src/companion/client/companion.js clockOf, dateTimeOf): the 24-hour clock in this computer's local time (21:18:36),
// with the date where a time can be another day's (2026-10-15 21:18:36); never a locale's 12-hour clock beside the strip's
// 24-hour one. Imports nothing, so it runs in Node's tests too.

const pad2 = (n) => String(n).padStart(2, '0');
const dateOf = (at) => (at instanceof Date ? at : new Date(at));

/** The time of day of `at` (a Date or an ISO time): "21:18:36"; '' for no time. */
export function clockOf(at) {
  const t = dateOf(at);
  return Number.isNaN(t.getTime()) ? '' : `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
}

/** The date and time of `at`: "2026-10-15 21:18:36"; '' for no time. */
export function dateTimeOf(at) {
  const t = dateOf(at);
  return Number.isNaN(t.getTime()) ? '' : `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${clockOf(t)}`;
}
