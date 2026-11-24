export function makeTimeFormatter(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return instant => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
    return `${parts.year.padStart(4, '0')}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}.${parts.second}`;
  };
}

export function setupDisplayTime(dialog, select, open) {
  const key = 'sot.display-time-zone';
  const extra = new Set(Intl.supportedValuesOf?.('timeZone') ?? ['America/New_York', 'Europe/London', 'Asia/Tokyo']);
  for (const option of select.options) extra.delete(option.value);
  for (const zone of extra) select.add(new Option(zone, zone));
  try { select.value = localStorage.getItem(key) ?? 'UTC'; } catch { /* Storage may be disabled. */ }
  if (!select.value) select.value = 'UTC';

  let zone, format;
  function apply() {
    zone = select.value === 'device' ? (new Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC') : select.value;
    format = makeTimeFormatter(zone);
    for (const time of document.querySelectorAll('time[data-display-clock]')) time.textContent = format(time.dateTime);
    for (const label of document.querySelectorAll('[data-display-zone]')) label.textContent = zone;
  }
  apply();
  open.addEventListener('click', () => dialog.showModal());
  select.addEventListener('change', () => {
    apply();
    try { localStorage.setItem(key, select.value); } catch { /* Apply for this page only. */ }
  });

  return {
    clock(instant, verified = false) {
      const time = document.createElement('time');
      time.dateTime = instant;
      time.dataset.displayClock = '';
      time.textContent = format(instant);
      if (verified) time.className = 'verified-time';
      return time;
    },
    zoneLabel() {
      const label = document.createElement('span');
      label.dataset.displayZone = '';
      label.textContent = zone;
      return label;
    },
  };
}
