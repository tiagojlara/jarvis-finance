import Logo from './Logo.jsx';

const pages = [
  ['overview', '◫', 'Overview'], ['portfolio', '▤', 'Portfolio'],
  ['networth', '⌂', 'Net worth'],
  ['activity', '↕', 'Activity'], ['dividends', '◌', 'Dividends'],
  ['cashflow', '⇄', 'Cash flow'],
  ['planning', '⌁', 'Retirement plan'],
  ['settings', '⚙', 'Settings & backup'],
];

export default function Sidebar({ page, navigate }) {
  return <aside className="sidebar">
    <div className="brand"><Logo size={35}/><span>jarvis<small>FINANCE · PERSONAL PORTFOLIO</small></span></div>
    <nav>{pages.map(([id, icon, label]) => <button key={id} onClick={() => navigate(id)} className={`nav-item ${page === id ? 'selected' : ''}`} aria-current={page === id ? 'page' : undefined}><span className="nav-icon">{icon}</span><span>{label}</span></button>)}</nav>
    <div className="privacy"><span className="privacy-dot" />Stored on this device<small>No account · No tracking</small></div>
  </aside>;
}
