import React, { useState } from 'react';
import {
  X,
  Download,
  Share2,
  Smartphone,
  Check,
  Copy,
  ShieldCheck,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { buildSignedAria48Apk, OfflineBundleAsset } from '../utils/androidApkBuilder';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface ShareApkModalProps {
  isOpen: boolean;
  onClose: () => void;
  trackTitle?: string | null;
}

interface OfflineManifestResponse {
  generatedAt?: string;
  manifestPrefix?: string;
  files: string[];
}

export default function ShareApkModal({ isOpen, onClose, trackTitle }: ShareApkModalProps) {
  const [copied, setCopied] = useState(false);
  const [isGeneratingApk, setIsGeneratingApk] = useState(false);
  const [buildProgressLabel, setBuildProgressLabel] = useState<string>('');
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [bundledInfo, setBundledInfo] = useState<{ files: number; sizeMb: string } | null>(null);
  const [apkError, setApkError] = useState<string | null>(null);
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();

  const currentUrl =
    typeof window !== 'undefined' && /^https?:\/\//i.test(window.location.origin)
      ? `${window.location.origin}/`
      : 'https://aria48-tracker.app/';

  const handleCopyLink = async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(currentUrl);
      } else {
        const input = document.createElement('input');
        input.value = currentUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      console.log('Copy failed:', e);
    }
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Aria48 Tracker - Universal Chiptune & MIDI Workstation',
          text: `Open Aria48 Tracker with 16 HTML5 oscilloscopes, spressasynth_core SF2/SFE SoundFonts, WebSID, and SunVox 2.1.4 WASM!${trackTitle ? ` Now playing: ${trackTitle}` : ''}`,
          url: currentUrl,
        });
      } catch (e) {
        console.log('Share canceled or failed:', e);
      }
    } else {
      void handleCopyLink();
    }
  };

  /**
   * Downloads the full compiled production web app (HTML/JS/CSS + SunVox WASM + WebSID WASM +
   * SpessaSynth AudioWorklet) and compiles a 100% offline signed Android APK that serves everything
   * from inside assets/www/ with zero Google AI Studio sign-in or network access required.
   */
  const handleDownloadApk = async () => {
    setIsGeneratingApk(true);
    setDownloadSuccess(false);
    setApkError(null);
    setBundledInfo(null);
    setBuildProgressLabel('Preparing offline app bundle...');

    try {
      const manifestResp = await fetch('/offline-apk-manifest.json', { cache: 'no-store' });
      if (!manifestResp.ok) {
        throw new Error(`Could not load offline bundle manifest (${manifestResp.status})`);
      }
      const manifest = (await manifestResp.json()) as OfflineManifestResponse;
      if (!manifest.files || manifest.files.length === 0) {
        throw new Error('Offline bundle manifest returned no files');
      }

      const prefix = manifest.manifestPrefix || '/';
      const offlineFiles: OfflineBundleAsset[] = [];

      for (let i = 0; i < manifest.files.length; i++) {
        const relPath = manifest.files[i];
        setBuildProgressLabel(`Packing offline assets (${i + 1}/${manifest.files.length})...`);
        const assetUrl = `${prefix.replace(/\/+$/, '')}/${relPath.replace(/^\/+/, '')}`;
        const assetResp = await fetch(assetUrl, { cache: 'no-store' });
        if (!assetResp.ok) {
          throw new Error(`Failed bundling offline asset ${relPath} (${assetResp.status})`);
        }
        let bytes: Uint8Array = new Uint8Array(await assetResp.arrayBuffer());

        // Inside the self-contained APK, remove PWA SW registration tag so WebView starts silently with zero SW lookups
        if (relPath === 'index.html') {
          const htmlStr = new TextDecoder()
            .decode(bytes)
            .replace(/<script[^>]*id=["']vite-plugin-pwa:register-sw["'][^>]*><\/script>/gi, '');
          bytes = new Uint8Array(new TextEncoder().encode(htmlStr));
        }

        offlineFiles.push({ path: relPath, data: bytes });
      }

      let iconPngBytes: Uint8Array = new Uint8Array(0);
      const bundledIcon = offlineFiles.find((f) => f.path === 'pwa-192x192.png');
      if (bundledIcon) {
        iconPngBytes = bundledIcon.data;
      } else {
        try {
          const iconResp = await fetch('/pwa-192x192.png');
          if (iconResp.ok) {
            iconPngBytes = new Uint8Array(await iconResp.arrayBuffer());
          }
        } catch {}
      }

      setBuildProgressLabel('Compiling Dalvik DEX & signing APK...');
      const { apkBytes, fileName, bundledFilesCount } = await buildSignedAria48Apk({
        offlineFiles,
        iconPngBytes,
        appName: 'Aria48 Tracker',
        packageName: 'com.aria48.tracker',
        versionName: '2.4.0',
        versionCode: 240,
      });

      const apkBufCopy = new Uint8Array(apkBytes.byteLength);
      apkBufCopy.set(apkBytes);
      const blob = new Blob([apkBufCopy], { type: 'application/vnd.android.package-archive' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      setBundledInfo({
        files: bundledFilesCount,
        sizeMb: (apkBytes.byteLength / (1024 * 1024)).toFixed(2),
      });
      setIsGeneratingApk(false);
      setBuildProgressLabel('');
      setDownloadSuccess(true);
    } catch (e: any) {
      console.warn('Offline APK generation failed:', e);
      setApkError(e?.message || 'Could not compile offline signed APK package');
      setIsGeneratingApk(false);
      setBuildProgressLabel('');
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4 backdrop-blur-md font-mono select-none">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          className="bg-zinc-950 border-2 border-emerald-500/40 rounded-2xl max-w-lg w-full p-6 text-zinc-100 shadow-[0_0_50px_rgba(16,185,129,0.2)] flex flex-col gap-5 relative overflow-hidden"
        >
          {/* Ambient Glow */}
          <div className="absolute top-0 right-0 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute bottom-0 left-0 w-48 h-48 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

          {/* Modal Header */}
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-emerald-950/60 border border-emerald-500/50 rounded-xl text-emerald-400">
                <Smartphone size={22} className="animate-pulse" />
              </div>
              <div>
                <h2 className="text-base font-black uppercase tracking-wider text-white flex items-center gap-2">
                  Offline Android APK
                  <span className="text-[9px] px-1.5 py-0.5 bg-emerald-950 text-emerald-300 rounded font-normal border border-emerald-800">
                    100% Offline · API 21–33
                  </span>
                </h2>
                <p className="text-[11px] text-zinc-400 font-sans">
                  Self-contained Android package — no internet or Google AI Studio sign-in required
                </p>
              </div>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 text-zinc-500 hover:text-white hover:bg-zinc-900 rounded-lg transition cursor-pointer"
            >
              <X size={18} />
            </button>
          </div>

          {/* Primary Offline APK Download Card */}
          <div className="bg-gradient-to-br from-emerald-950/40 via-zinc-900/60 to-black border border-emerald-500/30 rounded-xl p-4 flex flex-col gap-3 shadow-inner">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-xs font-bold text-emerald-300 uppercase tracking-wide">
                  <WifiOff size={14} className="text-emerald-400" />
                  <span>Aria48Tracker-v2.4.0-offline.apk</span>
                </div>
                <p className="text-[10.5px] text-zinc-400 font-sans mt-1 leading-relaxed">
                  Bundles the full Aria48 Studio, SunVox 2.1.4 WASM, SpessaSynth Core/AudioWorklet, and WebSID WASM directly inside <code className="text-emerald-300">assets/www/</code> with native Android file-picker support. Opens straight into the tracker in Airplane Mode with zero AI Studio login prompt.
                </p>
              </div>
              <span className="text-[9.5px] font-mono text-zinc-400 whitespace-nowrap bg-black/60 px-2 py-0.5 rounded border border-zinc-800">
                Standalone · v2
              </span>
            </div>

            {apkError && (
              <div className="text-[10px] font-mono text-red-300 bg-red-950/50 border border-red-700/60 rounded px-2.5 py-1.5">
                {apkError}
              </div>
            )}

            {downloadSuccess && bundledInfo && (
              <div className="text-[10px] font-mono text-emerald-300 bg-emerald-950/40 border border-emerald-700/50 rounded px-2.5 py-1.5">
                Bundled {bundledInfo.files} offline runtime files into {bundledInfo.sizeMb} MB signed APK.
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                id="modal-download-apk-btn"
                onClick={() => void handleDownloadApk()}
                disabled={isGeneratingApk}
                className="flex-1 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-bold rounded-lg text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(16,185,129,0.3)] cursor-pointer disabled:opacity-60"
              >
                {isGeneratingApk ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>{buildProgressLabel || 'Packaging Offline APK...'}</span>
                  </>
                ) : downloadSuccess ? (
                  <>
                    <Check size={15} className="text-white" />
                    <span>Offline APK Downloaded!</span>
                  </>
                ) : (
                  <>
                    <Download size={15} />
                    <span>Download Offline APK (.apk)</span>
                  </>
                )}
              </button>

              {isInstallable && !isInstalled && (
                <button
                  id="modal-install-pwa-btn"
                  onClick={() => void install()}
                  className="py-2.5 px-3 bg-cyan-600/30 hover:bg-cyan-600/50 text-cyan-300 font-bold rounded-lg text-xs tracking-wider transition border border-cyan-500/50 cursor-pointer flex items-center gap-1.5"
                  title="Install via Chrome WebAPK with offline caching"
                >
                  <Sparkles size={14} />
                  <span>Install WebAPK</span>
                </button>
              )}
            </div>

            {isIOS && !isInstalled && (
              <div className="text-[10px] text-cyan-300 bg-cyan-950/40 border border-cyan-700/40 rounded px-2.5 py-1.5 font-sans">
                On iPhone/iPad: tap Safari&apos;s <strong>Share</strong> icon and choose <strong>Add to Home Screen</strong>.
              </div>
            )}

            {/* Quick Install Guide */}
            <div className="mt-1 pt-2 border-t border-emerald-900/40 text-[9.5px] text-zinc-400 font-sans flex flex-col gap-1">
              <span className="text-emerald-400 font-mono font-bold text-[9px] uppercase tracking-wider">
                Installation on Android (Works 100% Offline):
              </span>
              <p>1. Tap Download Offline APK &gt; open the `.apk` file from Android Files or Downloads.</p>
              <p>2. Allow &quot;Install unknown apps&quot; if prompted; confirm Install (&quot;Install anyway&quot; for self-signed cert).</p>
              <p>3. Launch Aria48 Tracker anywhere — loads locally from APK assets with no Google login gate.</p>
            </div>
          </div>

          {/* Shareable Web URL Section */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3 flex flex-col gap-2">
            <span className="text-[10px] text-zinc-400 uppercase tracking-wider font-bold">
              Optional Web Studio URL (APK Runs Locally Offline):
            </span>
            <div className="flex items-center gap-1.5 bg-black border border-zinc-800 rounded-lg p-1.5">
              <input
                type="text"
                readOnly
                value={currentUrl}
                className="bg-transparent text-[10px] text-zinc-300 font-mono flex-1 focus:outline-none truncate px-1"
              />
              <button
                onClick={() => void handleCopyLink()}
                className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-[10px] font-bold transition flex items-center gap-1 cursor-pointer"
              >
                {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>

            <div className="flex items-center gap-2 mt-1">
              <button
                onClick={() => void handleNativeShare()}
                className="flex-1 py-1.5 px-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-[10px] font-bold uppercase tracking-wider transition flex items-center justify-center gap-1.5 cursor-pointer border border-zinc-700"
              >
                <Share2 size={12} className="text-cyan-400" />
                <span>Share Studio Link...</span>
              </button>
            </div>
          </div>

          {/* Modal Footer */}
          <div className="flex items-center justify-between text-[10px] text-zinc-500 border-t border-zinc-900 pt-3">
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={12} className="text-emerald-400" />
              Bundled Local Assets + Multi-Class DEX + v1/v2 Signed
            </span>
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-lg font-bold transition cursor-pointer"
            >
              Close
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
