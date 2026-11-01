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
