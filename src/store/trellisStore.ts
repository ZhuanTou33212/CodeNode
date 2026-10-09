import { create } from 'zustand';
import type { TrellisContext, TrellisProject } from '../lib/trellisTypes';
let revision = 0;
interface TrellisState {
  root: string | null; conversation: string; project: TrellisProject | null; context: TrellisContext | null; viewed: string | null; loading: boolean; busy: boolean; error: string;
  refresh: (root: string, conversation: string) => Promise<void>; view: (taskPath: string) => Promise<void>; bind: (taskPath: string | null) => Promise<void>;
}
export const useTrellisStore = create<TrellisState>((set, get) => ({
  root:null,conversation:'',project:null,context:null,viewed:null,loading:false,busy:false,error:'',
  refresh: async (root, conversation) => {
    const token=++revision, previous=get();
    set({root,conversation,loading:true,error:'',...(previous.root!==root?{project:null,context:null,viewed:null}:{})});
    try {
      const result=await window.codenode!.trellisProject(root,conversation); if(token!==revision)return;
      if(!result.ok||!result.value)throw new Error(result.error||'任务读取失败');
      const project=result.value, viewed=previous.root===root&&project.tasks.some(task=>task.taskPath===previous.viewed)?previous.viewed:project.selectedTask||project.tasks[0]?.taskPath||null;
      set({project,viewed,...(viewed!==previous.viewed?{context:null}:{})});
      if(viewed){const details=await window.codenode!.trellisContext(root,viewed);if(token!==revision)return;if(!details.ok||!details.value)throw new Error(details.error||'资料读取失败');set({context:details.value});}else set({context:null});
    }catch(error){if(token===revision)set({error:error instanceof Error?error.message:String(error)});}finally{if(token===revision)set({loading:false});}
  },
  view: async viewed => {
    const root=get().root;if(!root)return;const token=++revision;set({viewed,context:null,loading:true,error:''});
    try{const result=await window.codenode!.trellisContext(root,viewed);if(token!==revision)return;if(!result.ok||!result.value)throw new Error(result.error||'资料读取失败');set({context:result.value});}catch(error){if(token===revision)set({error:error instanceof Error?error.message:String(error)});}finally{if(token===revision)set({loading:false});}
  },
  bind: async taskPath => {
    const {root,conversation}=get();if(!root||get().busy)return;set({busy:true,error:''});
    try{const result=await window.codenode!.trellisSelect(root,conversation,taskPath);if(!result.ok)throw new Error(result.error||'任务绑定失败');if(root===get().root&&conversation===get().conversation)await get().refresh(root,conversation);}catch(error){if(root===get().root)set({error:error instanceof Error?error.message:String(error)});}finally{set({busy:false});}
  },
}));
