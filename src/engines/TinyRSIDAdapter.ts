/**
 * TinyRSIDBridge.ts
 * Capitalized multi-engine facade & AudioWorklet node adapter over `tinyRsidBridge.ts`
 * + `tinyrsid-worklet.ts` with WASM Engine Manager hot-swap support.
 */

import { WasmBundleStatus } from '../types';
import { TinyRsidBridge, TINYRSID_ENGINE_ID, SidChipOverride, SidClockOverride, SidRuntimeState } from './tinyRsidBridge';
import { createTinyRSIDNode, TinyRSIDNodeHandle } from './tinyrsid-worklet';

export { TinyRsidBridge, TINYRSID_ENGINE_ID };
export type { SidChipOverride, SidClockOverride, SidRuntimeState };

class TinyRSIDBridgeAdapter {
  public readonly engineId = TINYRSID_ENGINE_ID;
  private workletHandle: TinyRSIDNodeHandle | null = null;
  private status: WasmBundleStatus = 'unloaded';
  private customBundleName = '/websid/backend_sid.js';
  private error: string | null = null;

  public async attachToMasterRouter(ctx: AudioContext, destinationBus: AudioNode): Promise<void> {
    if (!this.workletHandle) {
      this.workletHandle = await createTinyRSIDNode(ctx);
    }
    if (this.workletHandle.node) {
      try { this.workletHandle.node.disconnect(); } catch {}
      this.workletHandle.node.connect(destinationBus);
    }
    TinyRsidBridge.getState();
    this.status = 'ready';
  }

  public async reloadWasmBundle(jsUrl: string, _wasmUrl?: string, label?: string): Promise<boolean> {
    this.status = 'loading';
    this.error = null;
    try {
      const res = await fetch(jsUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} loading TinyRSID script`);
      const script = document.createElement('script');
      script.src = jsUrl;
      script.async = false;
      await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Script error loading ${jsUrl}`));
        document.head.appendChild(script);
      });
      this.customBundleName = label || jsUrl;
      this.status = 'ready';
      return true;
    } catch (err: any) {
      this.status = 'error';
      this.error = err?.message || 'TinyRSID hot-swap failed';
      return false;
    }
  }

  public getBundleStatus() {
    const st = TinyRsidBridge.getState();
    return {
      status: st.hasSidLoaded ? ('ready' as WasmBundleStatus) : this.status,
      label: this.customBundleName,
      error: this.error,
    };
  }
}

export const TinyRSIDAdapter = new TinyRSIDBridgeAdapter();
