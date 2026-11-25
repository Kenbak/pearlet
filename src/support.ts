/** Pearlet's Mainnet donation address (Atmosphere Labs). */
export const supportAddress = 'prl1peseshla86zps48ns599vua2t4eflfjwr4wdkz2rvsk0gzeaeqpws4z9my6';

/** The optional tip on a send: 0.5% of the amount, in basis points. */
export const supportTipBasisPoints = 50;
const dustGrains = 333;

/** The tip for a send amount, or 0 when it would be too small to send. */
export function supportTipGrains(amountGrains: number): number {
  if (!Number.isSafeInteger(amountGrains) || amountGrains <= 0) return 0;
  const tip = Math.floor((amountGrains * supportTipBasisPoints) / 10_000);
  return tip >= dustGrains ? tip : 0;
}
