import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Deliberately no CopilotKit import here, and no `@copilotkit/react-core/v2/styles.css` either.
//
// Measured with `npm run build`: importing the provider at the entry takes the initial chunk from
// 311 kB (96 kB gzipped) to 2,874 kB (822 kB gzipped) — the library's markdown/code/UI stack lands on
// every page load of a local-first finance app, which is a worse answer to "is this fast on my machine"
// than the one a floating chat icon is supposed to be.
//
// So the provider lives inside components/TamanduaChat.jsx, which tamanduaState.jsx pulls in with a dynamic
// import the first time the launcher is pressed or /assistant is opened. Entry chunk after that split:
// 310 kB (96 kB gzipped), unchanged — and the conversation costs 258 kB gzipped, once, on demand.
createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>,
);
