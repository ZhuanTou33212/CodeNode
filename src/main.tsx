import React from 'react';
import ReactDOM from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App';
import { useGraphStore } from './store/graphStore';
import { useSessionStore } from './store/sessionStore';
import { useChatStore } from './store/chatStore';
import { useUiStore } from './store/uiStore';
import { getActiveVectorNode, getVectorStore, useVectorStore } from './vector/vectorStore';
import '@xyflow/react/dist/style.css';
import './styles.css';

const w = window as unknown as {
  __codenodeStore?: typeof useGraphStore;
  __codenodeSession?: typeof useSessionStore;
  __codenodeChat?: typeof useChatStore;
  __codenodeUi?: typeof useUiStore;
  __codenodeVector?: typeof useVectorStore;
  /** 按节点 id 取该画布节点的矢量文档 store（测试与调试用） */
  __codenodeVectorNode?: typeof getVectorStore;
  __codenodeVectorActive?: typeof getActiveVectorNode;
};
w.__codenodeStore = useGraphStore;
w.__codenodeSession = useSessionStore;
w.__codenodeChat = useChatStore;
w.__codenodeUi = useUiStore;
w.__codenodeVector = useVectorStore;
w.__codenodeVectorNode = getVectorStore;
w.__codenodeVectorActive = getActiveVectorNode;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </React.StrictMode>
);
