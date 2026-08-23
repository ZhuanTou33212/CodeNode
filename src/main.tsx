import React from 'react';
import ReactDOM from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App';
import { useGraphStore } from './store/graphStore';
import { useSessionStore } from './store/sessionStore';
import { useChatStore } from './store/chatStore';
import './styles.css';
import '@xyflow/react/dist/style.css';

const w = window as unknown as {
  __codenodeStore?: typeof useGraphStore;
  __codenodeSession?: typeof useSessionStore;
  __codenodeChat?: typeof useChatStore;
};
w.__codenodeStore = useGraphStore;
w.__codenodeSession = useSessionStore;
w.__codenodeChat = useChatStore;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </React.StrictMode>
);
