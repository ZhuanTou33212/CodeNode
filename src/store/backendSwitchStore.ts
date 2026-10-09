import { create } from 'zustand';
/** Blocks new sends while changing the backend and creating its fresh conversation. */
export const useBackendSwitchStore = create<{ switching: boolean }>(() => ({ switching: false }));
