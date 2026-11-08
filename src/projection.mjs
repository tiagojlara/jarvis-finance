// Single shared retirement projection. The server, the browser (via Vite), and the
// tests all use this exact implementation — no UI may keep its own copy.
//
// Monthly compounding: each year starts at the current value, then 12 months apply
// growth, contributions, and withdrawals. Returns points for years 0..years, where
// point[i].value is the portfolio at the START of year i (so the final point is the
// value after `years` full years).
export function project({
  startingValue = 0,
  monthlyContribution = 0,
  annualReturn = 0,
  inflation = 0,
  years = 0,
  monthlyWithdrawal = 0,
} = {}) {
  const points = [];
  let value = Number(startingValue);
  const contribution = Number(monthlyContribution);
  const withdrawal = Number(monthlyWithdrawal);
  for (let year = 0; year <= years; year += 1) {
    points.push({ year, value, realValue: value / (1 + inflation) ** year });
    for (let month = 0; month < 12; month += 1) {
      value = value * (1 + annualReturn) ** (1 / 12) + contribution - withdrawal;
    }
  }
  return points;
}

export function projectedValue(options) {
  return project(options).at(-1).value;
}

// Real retirement projection in today's purchasing power. Contributions and
// pre-retirement withdrawals remain constant in real terms. At retirement, the
// first year's withdrawal is 4% of the retirement balance, then stays constant
// in real terms so the nominal amount rises with inflation each year.
export function projectRetirement({
  startingValue = 0,
  monthlyContribution = 0,
  annualReturn = 0,
  inflation = 0,
  yearsToRetirement = 0,
  retirementYears = 30,
  monthlyWithdrawal = 0,
  withdrawalRate = 0.04,
} = {}) {
  const workYears = Math.max(0, Math.floor(Number(yearsToRetirement)));
  const drawdownYears = Math.max(0, Math.floor(Number(retirementYears)));
  const realAnnualReturn = (1 + Number(annualReturn)) / (1 + Number(inflation)) - 1;
  const monthlyGrowth = (1 + realAnnualReturn) ** (1 / 12);
  let value = Number(startingValue);
  let retirementMonthlyWithdrawal = null;
  const points = [];

  for (let year = 0; year <= workYears + drawdownYears; year += 1) {
    if (year === workYears) retirementMonthlyWithdrawal = Math.max(0, value * Number(withdrawalRate) / 12);
    const retired = year >= workYears;
    const withdrawal = retired ? retirementMonthlyWithdrawal : Number(monthlyWithdrawal);
    points.push({ year, value, phase: retired ? 'Retirement' : 'Accumulation', monthlyWithdrawal: withdrawal || 0 });

    for (let month = 0; month < 12; month += 1) {
      value = Math.max(0, value * monthlyGrowth + (retired ? 0 : Number(monthlyContribution)) - (withdrawal || 0));
    }
  }

  const retirementPoint = points[workYears];
  return {
    points,
    retirementValue: retirementPoint?.value ?? value,
    monthlyIncome: retirementPoint?.monthlyWithdrawal ?? 0,
    realAnnualReturn,
    withdrawalRate: Number(withdrawalRate),
  };
}
