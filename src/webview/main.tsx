import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { GROUP_HEADER_HEIGHT, ROW_HEIGHT } from './format.js';
// Imported before theme.css so our overrides win the ties: the codicon base
// rule is `.codicon[class*='codicon-']`, which is as specific as the class
// selectors that adjust it.
import '@vscode/codicons/dist/codicon.css';
import './theme.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Orizzonte webview: #root is missing from the host HTML');
}

// The virtualizer positions rows by these numbers, so the stylesheet has to
// agree with them exactly — publishing them here keeps one definition.
document.documentElement.style.setProperty(
  '--orizzonte-row-height',
  `${ROW_HEIGHT}px`,
);
document.documentElement.style.setProperty(
  '--orizzonte-group-height',
  `${GROUP_HEADER_HEIGHT}px`,
);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
