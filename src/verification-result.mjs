export const TSR_SPREAD_SECONDS = 300;
export const OTS_DRIFT_HOURS = 24;
const TSR_SPREAD_MS = TSR_SPREAD_SECONDS * 1_000;
const OTS_DRIFT_MS = OTS_DRIFT_HOURS * 60 * 60 * 1_000;

export function summarizeTimestamps(checks, { signatureFailed = false } = {}) {
  if (!checks.length) return;
  const verified = checks.map(check => ({ ...check, ms: Date.parse(check.time) })).filter(check => Number.isFinite(check.ms));
  const tsrs = verified.filter(check => check.type === 'tsr').sort((a, b) => a.ms - b.ms);
  const anchors = verified.filter(check => check.type === 'ots').sort((a, b) => a.ms - b.ms);
  const earliest = tsrs[0] ?? anchors[0];
  const headline = { time: earliest?.time, timeType: earliest?.type };
  const fail = reason => ({ ...headline, pass: false, reason });
  if (signatureFailed) return fail('OpenPGP 验签失败。');
  if (verified.length !== checks.length) return fail('有时间戳未完成验证或验证失败，见下方明细。');
  if (!tsrs.length || !anchors.length) return fail('联合校验至少需要一份已验证 TSR 和一份已验证 OTS。');
  const spread = tsrs.at(-1).ms - tsrs[0].ms;
  if (spread > TSR_SPREAD_MS) return fail(`最早与最晚 TSR 相差 ${spread / 1000} 秒，超过 ${TSR_SPREAD_SECONDS} 秒。`);
  const targets = new Set(verified.map(check => check.target));
  for (const target of targets) {
    const sameTsrs = tsrs.filter(check => check.target === target);
    const sameAnchors = anchors.filter(check => check.target === target);
    if (!sameTsrs.length || !sameAnchors.length) return fail('每个打戳对象都须同时有已验证的 TSR 和 OTS。');
    if (sameAnchors.some(({ ms }) => Math.max(Math.abs(ms - sameTsrs[0].ms), Math.abs(ms - sameTsrs.at(-1).ms)) > OTS_DRIFT_MS)) {
      return fail(`同一打戳对象的 OTS 区块标记时间与 TSR 签发时间相差超过 ${OTS_DRIFT_HOURS} 小时。`);
    }
  }
  return { ...headline, pass: true, reason: tsrs.length === 1 ? '仅一份 TSR；TSR 时间跨度按 0 秒计。' : `最早与最晚 TSR 相差 ${spread / 1000} 秒。` };
}
