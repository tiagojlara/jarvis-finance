// Jarvis Finance mark: a rising portfolio line toward the north star.
// Keep in sync with public/favicon.svg.
export default function Logo({ size = 35 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="jf-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#378564"/>
          <stop offset="1" stopColor="#265c4d"/>
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#jf-bg)"/>
      <polyline points="12,46 24,38 34,43 45,28" fill="none" stroke="#f5f7f3" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M47 8 L50.6 17.4 L60 21 L50.6 24.6 L47 34 L43.4 24.6 L34 21 L43.4 17.4 Z" fill="#e0a06a"/>
    </svg>
  );
}
