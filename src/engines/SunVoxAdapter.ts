/**
 * SunVoxBridge.ts
 * Capitalized multi-engine facade & AudioWorklet adapter over `sunvoxBridge.ts`
 * + `sunvox-worklet.ts` (`sv_audio_callback()`) + hot-swap bundle management.
 */

import { WasmBundleStatus } from '../types';
import {
  SunVoxBridge,
  SUNVOX_ENGINE_ID,
  SUNVOX_JS_URL,
  SUNVOX_WASM_URL,
  SunVoxModuleInfo,
  SunVoxEffectActivity,
  SunVoxRuntimeState,
} from './sunvoxBridge';
import { createSunVoxNode, SunVoxNodeHandle } from './sunvox-worklet';

export { SunVoxBridge, SUNVOX_ENGINE_ID, SUNVOX_JS_URL, SUNVOX_WASM_URL };
export type { SunVoxModuleInfo, SunVoxEffectActivity, SunVoxRuntimeState };

class SunVoxBridgeAdapter {
  public readonly engineId = SUNVOX_ENGINE_ID;
  private workletHandle: SunVoxNodeHandle | null = null;
  private customBundleLabel = SUNVOX_JS_URL;
  private status: WasmBundleStatus = 'unloaded';
  private error: string | null = null;

  public async attachToMasterRouter(ctx: AudioContext, destinationBus: AudioNode): Promise<void> {
    SunVoxBridge.setHostAudioContext(ctx);
    if (!this.workletHandle) {
      this.workletHandle = await createSunVoxNode(ctx);
    }
    if (this.workletHandle.node) {
      try { this.workletHandle.node.disconnect(); } catch {}
      this.workletHandle.node.connect(destinationBus);
    }
  }

  public async reloadWasmBundle(jsUrl: string, wasmUrl?: string, label?: string): Promise<boolean> {
    this.status = 'loading';
    this.error = null;
    try {
      const script = document.createElement('script');
      script.src = jsUrl;
      script.async = false;
      await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed loading SunVox JS from ${jsUrl}`));
        document.head.appendChild(script);
      });
      if (wasmUrl && typeof (window as any).SunVoxLib === 'function') {
        await (window as any).SunVoxLib({
          locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p),
        });
      }
      this.customBundleLabel = label || jsUrl;
      this.status = 'ready';
      return true;
    } catch (err: any) {
      this.status = 'error';
      this.error = err?.message || 'SunVox bundle reload failed';
      return false;
    }
  }

  public getBundleStatus() {
    const sv = SunVoxBridge.getState();
    return {
      status: sv.isReady ? ('ready' as WasmBundleStatus) : sv.error ? ('error' as WasmBundleStatus) : this.status,
      label: this.customBundleLabel,
      error: sv.error || this.error,
    };
  }
}

export const SunVoxAdapter = new SunVoxBridgeAdapter();
