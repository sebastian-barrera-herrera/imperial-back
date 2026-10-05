export type SimulationInput = {
  principal: number;
  annualRate: number; // porcentaje nominal anual, p. ej. 12 = 12 %
  termMonths: number;
  mode: 'COMPOUND' | 'SIMPLE';
};

export type SimulationResult = {
  principal: number;
  annualRate: number;
  termMonths: number;
  mode: SimulationInput['mode'];
  finalAmount: number;
  totalInterest: number;
  effectiveAnnualRate: number;
  schedule: { month: number; interest: number; balance: number }[];
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Proyección mes a mes. COMPOUND capitaliza el interés mensualmente; SIMPLE lo calcula siempre sobre el capital inicial.
 * Es una estimación informativa, no una oferta vinculante.
 */
export function simulate({ principal, annualRate, termMonths, mode }: SimulationInput): SimulationResult {
  const monthly = annualRate / 100 / 12;
  const schedule: SimulationResult['schedule'] = [];
  let balance = principal;
  for (let month = 1; month <= termMonths; month++) {
    const interest = mode === 'COMPOUND' ? balance * monthly : principal * monthly;
    balance += interest;
    schedule.push({ month, interest: round2(interest), balance: round2(balance) });
  }
  const finalAmount = round2(balance);
  const years = termMonths / 12;
  return {
    principal,
    annualRate,
    termMonths,
    mode,
    finalAmount,
    totalInterest: round2(finalAmount - principal),
    effectiveAnnualRate: round2((Math.pow(finalAmount / principal, 1 / years) - 1) * 100),
    schedule,
  };
}
