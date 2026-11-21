import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        id="pwa-install-btn"
        type="button"
        onClick={() => void install()}
        className="flex items-center gap-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-[0_0_12px_rgba(16,185,129,0.28)] transition cursor-pointer border border-emerald-400/50"
        title="Install Aria48 Tracker as a standalone mobile/desktop app"
      >
        <Download size={13} />
        <span>Install App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          id="pwa-ios-install-btn"
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950/50 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300 hover:bg-cyan-900/60 transition cursor-pointer"
        >
          <Smartphone size={13} />
          <span>Install iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-xl bg-zinc-950 border border-cyan-500/40 p-5 shadow-2xl text-zinc-100">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-black uppercase tracking-wider text-white">Install on iPhone / iPad</h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="p-1 text-zinc-400 hover:text-white rounded"
                >
                  <X size={16} />
                </button>
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed">
                1. Tap the <strong>Share</strong> button in Safari&apos;s toolbar.<br />
                2. Scroll down and tap <strong>Add to Home Screen</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full rounded-lg bg-zinc-800 hover:bg-zinc-700 py-2 text-xs font-bold uppercase tracking-wider text-white cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
