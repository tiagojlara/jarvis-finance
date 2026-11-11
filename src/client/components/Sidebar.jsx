import Logo from './Logo.jsx';

// Ask Jarvis is deliberately not in this list. The assistant is a launcher present on every page
// (components/AssistantDock.jsx), which was the point of moving it out of a dedicated page; the /assistant
// route still works as a deep link and as the expanded conversation view. Six entries here also keeps the
// two nav groups below on separate rows — slice(0,6) is "YOUR FINANCES", slice(6) is "PLAN & SETTINGS".
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
    <nav aria-label="Main navigation"><div className="nav-group-label">YOUR FINANCES</div>{pages.slice(0, 6).map(([id, icon, label]) => <button key={id} onClick={() => navigate(id)} className={`nav-item ${page === id ? 'selected' : ''}`} aria-current={page === id ? 'page' : undefined}><span className="nav-icon" aria-hidden="true">{icon}</span><span>{label}</span></button>)}<div className="nav-group-label nav-group-tools">PLAN &amp; SETTINGS</div>{pages.slice(6).map(([id, icon, label]) => <button key={id} onClick={() => navigate(id)} className={`nav-item ${page === id ? 'selected' : ''}`} aria-current={page === id ? 'page' : undefined}><span className="nav-icon" aria-hidden="true">{icon}</span><span>{label}</span></button>)}</nav>
    <div className="privacy"><span className="privacy-dot" />Stored on this device<small>No account · No tracking</small></div>
  </aside>;
}
