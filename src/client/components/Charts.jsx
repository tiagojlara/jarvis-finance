import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { money } from '../api.js';

const palette = ['#2f6e5b', '#e0a06a', '#89a895', '#899aa4', '#c57660', '#aab67a', '#8a72a6'];
const shortDate = (date) => {
  const value = new Date(`${/^\d{4}-\d{2}$/.test(date) ? `${date}-01` : date}T12:00:00`);
  return Number.isNaN(value.getTime()) ? date : new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(value);
};
const axisStyle = { fill: '#8b9991', fontSize: 10 };
const tooltipStyle = { border: '1px solid #e7ebe6', borderRadius: 8, fontSize: 11 };

export function PortfolioValueChart({ data = [], currency = 'EUR' }) {
  if (data.length < 2) return <div className="empty-chart">Add dated prices and exchange rates to see portfolio history.</div>;
  return <div className="chart-frame"><ResponsiveContainer width="100%" height={280}>
    <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
      <defs><linearGradient id="portfolioFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2f6e5b" stopOpacity={0.22}/><stop offset="100%" stopColor="#2f6e5b" stopOpacity={0.01}/></linearGradient></defs>
      <CartesianGrid stroke="#edf0ec" strokeDasharray="3 4" vertical={false}/>
      <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={28} tick={axisStyle} axisLine={false} tickLine={false}/>
      <YAxis tickFormatter={(value) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)} width={52} tick={axisStyle} axisLine={false} tickLine={false}/>
      <Tooltip labelFormatter={(date) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${date}T12:00:00`))} formatter={(value) => [money(Number(value), currency), 'Portfolio value']} contentStyle={tooltipStyle}/>
      <Area type="monotone" dataKey="value" stroke="#2f6e5b" strokeWidth={2.5} fill="url(#portfolioFill)" activeDot={{ r: 5, strokeWidth: 0 }}/>
    </AreaChart>
  </ResponsiveContainer></div>;
}

// Stacked monthly income: `series` is one { key, name } segment per asset, and each
// data row is { month, [key]: amount }. The full bar height stays the month total.
export function DividendChart({ data = [], series = [], currency = 'EUR' }) {
  if (!data.length) return <div className="empty-chart">Record dividend payments to see income history.</div>;
  const segments = series.length ? series : [{ key: 'amount', name: 'Paid' }];
  return <div className="chart-frame"><ResponsiveContainer width="100%" height={250}>
    <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
      <CartesianGrid stroke="#edf0ec" strokeDasharray="3 4" vertical={false}/>
      <XAxis dataKey="month" tickFormatter={shortDate} minTickGap={24} tick={axisStyle} axisLine={false} tickLine={false}/>
      <YAxis tickFormatter={(value) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)} width={52} tick={axisStyle} axisLine={false} tickLine={false}/>
      <Tooltip labelFormatter={shortDate} formatter={(value, name) => [money(Number(value), currency), name]} contentStyle={tooltipStyle}/>
      {segments.length > 1 && <Legend iconType="circle" wrapperStyle={{ fontSize: 10 }}/>}
      {segments.map((segment, index) => (
        <Bar key={segment.key} dataKey={segment.key} name={segment.name} stackId="income"
          fill={palette[index % palette.length]} maxBarSize={36}
          radius={index === segments.length - 1 ? [4, 4, 0, 0] : undefined}/>
      ))}
    </BarChart>
  </ResponsiveContainer></div>;
}

export function Sparkline({ values = [], labels = [], color = '#2f6e5b', emptyMessage = 'Your history will appear as you add records.' }) {
  if (!values.length) return <div className="empty-chart">{emptyMessage}</div>;
  const data = values.map((value, index) => ({ label: labels[index] || String(index + 1), value }));
  return <div className="chart-frame chart-frame-small"><ResponsiveContainer width="100%" height={150}>
    <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
      <CartesianGrid stroke="#edf0ec" strokeDasharray="3 4" vertical={false}/>
      <XAxis dataKey="label" tickFormatter={shortDate} minTickGap={22} tick={axisStyle} axisLine={false} tickLine={false}/>
      <YAxis hide domain={['auto', 'auto']}/>
      <Tooltip labelFormatter={shortDate} formatter={(value) => [Number(value).toLocaleString(), 'Value']} contentStyle={tooltipStyle}/>
      <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }}/>
    </LineChart>
  </ResponsiveContainer></div>;
}

export function ScenarioChart({ lines, currency = 'EUR' }) {
  if (!lines.some((line) => line.values.length)) return <div className="empty-chart">Set a retirement age to see the projection.</div>;
  const length = Math.max(...lines.map((line) => line.values.length));
  const rows = Array.from({ length }, (_, index) => Object.fromEntries([['year', index], ...lines.map((line) => [line.label, line.values[index] ?? null])]));
  return <div className="chart-frame"><ResponsiveContainer width="100%" height={260}>
    <LineChart data={rows} margin={{ top: 8, right: 14, bottom: 0, left: 0 }}>
      <CartesianGrid stroke="#edf0ec" strokeDasharray="3 4" vertical={false}/>
      <XAxis dataKey="year" tickFormatter={(year) => `+${year}y`} tick={axisStyle} axisLine={false} tickLine={false}/>
      <YAxis tickFormatter={(value) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)} width={52} tick={axisStyle} axisLine={false} tickLine={false}/>
      <Tooltip labelFormatter={(year) => `${year} years`} formatter={(value, name) => [money(Number(value), currency), name]} contentStyle={tooltipStyle}/>
      <Legend iconType="circle" wrapperStyle={{ fontSize: 10 }}/>
      {lines.map((line, index) => <Line key={line.label} type="monotone" dataKey={line.label} stroke={palette[index % palette.length]} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }}/>) }
    </LineChart>
  </ResponsiveContainer></div>;
}

export function AllocationBar({ entries = [] }) {
  const total = entries.reduce((sum, [, amount]) => sum + Math.max(0, amount), 0);
  if (!total) return <div className="empty-chart">Add assets and prices to see allocation.</div>;
  const data = entries.filter(([, value]) => value > 0).map(([name, value]) => ({ name, value }));
  return <div className="allocation-chart"><div className="allocation-donut"><ResponsiveContainer width="100%" height={190}>
    <PieChart><Pie data={data} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="82%" paddingAngle={2} stroke="#fff" strokeWidth={2}>{data.map((item, index) => <Cell key={item.name} fill={palette[index % palette.length]}/>)}</Pie><Tooltip formatter={(value, name) => [`${money(Number(value))} · ${Math.round(Number(value) / total * 100)}%`, name]} contentStyle={tooltipStyle}/></PieChart>
  </ResponsiveContainer></div><div className="allocation-legend">{data.map((item, index) => <div className="allocation-row" key={item.name}><span><i style={{ background: palette[index % palette.length] }}/>{item.name}</span><b>{Math.round(item.value / total * 100)}%</b></div>)}</div></div>;
}
