/** numerator / denominator rounded half away from zero (ADR 0002: the plugin's own divisions). */
export function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const sign = numerator < 0n ? -1n : 1n;
  return sign * ((sign * numerator * 2n + denominator) / (denominator * 2n));
}
