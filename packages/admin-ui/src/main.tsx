import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { InstrumentsPage } from './InstrumentsPage.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InstrumentsPage />
  </StrictMode>,
);
