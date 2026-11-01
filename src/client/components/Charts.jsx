export function Sparkline({ values = [], color = '#2f6e5b', emptyMessage = 'Your history will appear as you add transactions.' }) {
  if (!values.length) return <div className="empty-chart">{emptyMessage}</div>;
  const max = Math.max(...values, 1); const min = Math.min(...values, 0); const width = 600; const height = 185;
  const points = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * width},${height - 12 - ((v - min) / (max - min || 1)) * (height - 26)}`).join(' ');
  return <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Portfolio history line chart"><path d={`M0 ${height - 4} H${width}`} stroke="#e9ede8"/><polyline fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" points={points}/></svg>;
}

export function ScenarioChart({ lines }) {
  if (!lines.some((line) => line.values.length)) return <div className="empty-chart">Set a retirement age to see the projection.</div>;
  const all = lines.flatMap((line) => line.values); const max = Math.max(...all, 1); const min = Math.min(...all, 0); const width = 600; const height = 190;
  const colors = ['#8b9c92', '#2f6e5b', '#e0a06a'];
  return <div><svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Retirement scenarios by year"><path d={`M0 ${height - 4} H${width}`} stroke="#e9ede8"/>{lines.map((line, index) => { const points = line.values.map((v, i) => `${(i / Math.max(line.values.length - 1, 1)) * width},${height - 12 - ((v - min) / (max - min || 1)) * (height - 25)}`).join(' '); return <polyline key={line.label} fill="none" stroke={colors[index % colors.length]} strokeWidth="2.5" strokeLinecap="round" points={points}/>; })}</svg><div className="chart-legend">{lines.map((line, index) => <span key={line.label}><i style={{ background: colors[index % colors.length] }}/>{line.label}</span>)}</div></div>;
}

export function AllocationBar({ entries = [] }) {
  const total = entries.reduce((sum, [, amount]) => sum + Math.max(0, amount), 0);
  const colors = ['#2f6e5b', '#e0a06a', '#89a895', '#899aa4', '#c57660', '#aab67a'];
  if (!total) return <div className="empty-chart">Add assets and prices to see allocation.</div>;
  return <div className="allocation"><div className="allocation-bar">{entries.map(([label, amount], i) => <span title={`${label}: ${Math.round(amount / total * 100)}%`} key={label} style={{ width: `${Math.max(0, amount) / total * 100}%`, background: colors[i % colors.length] }}/>)}</div>{entries.map(([label, amount], i) => <div className="allocation-row" key={label}><span><i style={{ background: colors[i % colors.length] }}/>{label}</span><b>{Math.round(amount / total * 100)}%</b></div>)}</div>;
}
