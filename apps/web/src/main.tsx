import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/700.css';
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/700.css';
import { App } from './App';
import { AppearanceProvider } from './Appearance';
import './tokens.css';
import './styles.css';
import './polish.css';
import './appearance.css';
import './reader.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter><AppearanceProvider><App /></AppearanceProvider></BrowserRouter></React.StrictMode>,
);
