/** Restoring official configuration is the only standalone routing action.
 * Gateway/account selection belongs to the model application flow. */
export function CodexRoutingMode({busy,canRestore,onOfficial}:{busy:boolean;canRestore:boolean;onOfficial:()=>void}){
 return <div className="tfRow"><button type="button" disabled={busy||!canRestore} onClick={onOfficial}>使用官方直连</button></div>;
}
