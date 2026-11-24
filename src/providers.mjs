export const tsa = {
  digicert: { label: 'DigiCert', url: 'http://timestamp.digicert.com' },
  freetsa: { label: 'FreeTSA', url: 'https://freetsa.org/tsr', signer: true },
};

export const calendars = [
  'https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org',
  'https://ots.btc.catallaxy.com',
];
export const calendarOrigins = new Set([...calendars,
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
  'https://a.pool.eternitywall.com',
]);
