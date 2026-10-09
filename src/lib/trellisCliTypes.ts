export interface TrellisCliSettings {executable:string;developer:string}
export interface TrellisCliInfo {settings:TrellisCliSettings;found:boolean;supported:boolean;version:string;entry:string;error:string}
export interface TrellisConnectPlan {id:string;root:string;status:string;developer:string;cliVersion:string;totalBytes:number;files:{source:string;bytes:number;fingerprint:string}[];diagnostics:{source:string;error:string}[]}
