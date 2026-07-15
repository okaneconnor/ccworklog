export function localDayOf(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d)) return null;
  return d.toLocaleDateString('sv-SE'); // YYYY-MM-DD in the system timezone
}

export function localMidnight(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d); // local-time constructor handles DST correctly
}

export function addDays(day, n) {
  const d = localMidnight(day);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
}

export function isoWithOffset(d) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

export function resolveRange(arg, now = new Date()) {
  const today = now.toLocaleDateString('sv-SE');
  let start, end, label;
  if (!arg || arg === 'today') { start = end = label = today; }
  else if (arg === 'yesterday') { start = end = label = addDays(today, -1); }
  else if (arg === 'week' || arg === 'lastweek') {
    const dow = (localMidnight(today).getDay() + 6) % 7; // 0 = Monday
    let monday = addDays(today, -dow);
    if (arg === 'lastweek') monday = addDays(monday, -7);
    start = monday;
    end = arg === 'week' ? today : addDays(monday, 6);
    label = `week-of-${monday}`;
  } else if (DAY_RE.test(arg)) { start = end = label = arg; }
  else if (RANGE_RE.test(arg)) { [, start, end] = arg.match(RANGE_RE); label = `${start}..${end}`; }
  else throw new Error(`Unrecognized range: ${arg}. Use today|yesterday|week|lastweek|YYYY-MM-DD|A..B`);
  if (start > end) throw new Error(`Range start ${start} is after end ${end}`);
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const startDate = localMidnight(start);
  const endDate = localMidnight(addDays(end, 1)); // exclusive upper bound
  return {
    days, label,
    sinceISO: isoWithOffset(startDate), untilISO: isoWithOffset(endDate),
    startMs: startDate.getTime(), endMs: endDate.getTime(),
  };
}
