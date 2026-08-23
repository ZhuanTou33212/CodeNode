import React from 'react';
import ReactDOM from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App';
import { useGraphStore } from './store/graphStore';
import './styles.css';
import '@xyflow/react/dist/style.css';

(window as unknown as { __codenodeStore?: typeof useGraphStore }).__codenodeStore = useGraphStore;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </React.StrictMode>
);
