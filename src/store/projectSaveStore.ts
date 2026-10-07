import { create } from 'zustand';
export type ProjectSaveStatus = 'idle' | 'saved' | 'dirty' | 'saving' | 'error';
export const useProjectSaveStore=create<{key:string;status:ProjectSaveStatus;error:string;savedFingerprint:string}>()(()=>({key:'',status:'idle',error:'',savedFingerprint:''}));
