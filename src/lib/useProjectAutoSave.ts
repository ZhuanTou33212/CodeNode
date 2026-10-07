import { useEffect } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useGraphStore } from '../store/graphStore';
import { useSessionStore } from '../store/sessionStore';
import { useCheckpointStore } from '../store/checkpointStore';
import { useUiStore } from '../store/uiStore';
import { useProjectSaveStore } from '../store/projectSaveStore';
import { captureProjectSnapshot,persistProjectSnapshot,type ProjectSnapshot } from './projectActions';
export function useProjectAutoSave() {
  const root=useProjectStore(s=>s.root),file=useProjectStore(s=>s.projectFile),loading=useProjectStore(s=>s.loading);
  const enabled=useUiStore(s=>s.preferences.autoSaveEnabled),delay=useUiStore(s=>s.preferences.autoSaveDelayMs);
  useEffect(()=>{
    if(!root||!file||loading){if(!root||!file)useProjectSaveStore.setState({key:'',status:'idle',savedFingerprint:'',error:''});return;}
    const initial=captureProjectSnapshot(),key=initial.key;
    if(useProjectSaveStore.getState().key!==key)useProjectSaveStore.setState({key,status:'saved',savedFingerprint:initial.fingerprint,error:''});
    let timer:ReturnType<typeof setTimeout>|null=null;
    let pending:ProjectSnapshot|null=null;
    let checking=false;
    const check=()=>{
      if(checking)return;checking=true;
      try {
        const project=useProjectStore.getState();if(project.loading||project.root!==root||project.projectFile!==file)return;
        const snapshot=captureProjectSnapshot(),state=useProjectSaveStore.getState();
        if(snapshot.fingerprint===state.savedFingerprint){if(timer)clearTimeout(timer);timer=null;pending=null;if(state.status==='dirty')useProjectSaveStore.setState({status:'saved'});return;}
        if(state.status!=='saving'&&state.status!=='error'&&state.status!=='dirty')useProjectSaveStore.setState({status:'dirty'});
        if(state.status==='error'){if(timer)clearTimeout(timer);timer=null;pending=null;return;}
        if(!enabled||pending?.fingerprint===snapshot.fingerprint)return;
        if(timer)clearTimeout(timer);pending=snapshot;
        timer=setTimeout(()=>{const save=pending;timer=null;pending=null;if(save)void persistProjectSnapshot(save,true)},delay);
      }catch(error){useProjectSaveStore.setState({status:'error',error:String(error)})}
      finally{checking=false;}
    };
    const subscriptions=[useGraphStore.subscribe(check),useSessionStore.subscribe(check),useCheckpointStore.subscribe(check),useUiStore.subscribe((next,prev)=>{if(next.viewport!==prev.viewport)check()}),useProjectSaveStore.subscribe(check)];
    check();
    return()=>{
      subscriptions.forEach(unsubscribe=>unsubscribe());if(timer)clearTimeout(timer);
      if(pending&&enabled){const current=useProjectStore.getState();if(current.root!==root||current.projectFile!==file)void persistProjectSnapshot(pending,true);}
    };
  },[root,file,loading,enabled,delay]);
}
