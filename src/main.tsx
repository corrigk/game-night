import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './admin/AdminPage';
import { PlayPage } from './phone/PlayPage';
import { RecapPage } from './recap/RecapPage';
import { TVPage } from './tv/TVPage';
import './styles/global.css';
import './styles/games.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<TVPage />} />
        <Route path="/play" element={<PlayPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/recap" element={<RecapPage />} />
        <Route path="*" element={<Navigate to="/play" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
