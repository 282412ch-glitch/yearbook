import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/700.css';
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/700.css';
import { App } from './App';
import './tokens.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>,
);
