import React from 'react';
import ReactDOM from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App';
import { useGraphStore } from './store/graphStore';
import { useSessionStore } from './store/sessionStore';
import { useChatStore } from './store/chatStore';
import { useUiStore } from './store/uiStore';
import { useVectorStore } from './vector/vectorStore';
import './styles.css';
import '@xyflow/react/dist/style.css';

const w = window as unknown as {
  __codenodeStore?: typeof useGraphStore;
  __codenodeSession?: typeof useSessionStore;
  __codenodeChat?: typeof useChatStore;
  __codenodeUi?: typeof useUiStore;
  __codenodeVector?: typeof useVectorStore;
};
w.__codenodeStore = useGraphStore;
w.__codenodeSession = useSessionStore;
w.__codenodeChat = useChatStore;
w.__codenodeUi = useUiStore;
w.__codenodeVector = useVectorStore;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </React.StrictMode>
);
