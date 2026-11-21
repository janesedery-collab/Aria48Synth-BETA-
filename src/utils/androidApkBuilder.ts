/**
 * androidApkBuilder.ts
 * Spec-compliant Offline Android APK binary compiler & signer:
 * - Compiled Binary AXML AndroidManifest.xml (API 21..33)
 * - Compiled resources.arsc (@string/app_name, @mipmap/ic_launcher)
 * - Multi-class Dalvik Executable classes.dex (035):
 *     MainActivity + OfflineClient (shouldInterceptRequest -> assets/www/) + OfflineChromeClient (file picker)
 * - Bundles entire production web app under assets/www/ (DEFLATE compressed)
 * - 4-byte zipaligned STORED system binaries/resources + v1 JAR Signature + APK Signature Scheme v2
 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  const MOD_ADLER = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

function sha1(data: Uint8Array): Uint8Array {
  const ml = data.length * 8;
  const padLen = ((56 - ((data.length + 1) % 64)) + 64) % 64;
  const buf = new Uint8Array(data.length + 1 + padLen + 8);
  buf.set(data, 0);
  buf[data.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(ml / 0x100000000), false);
  dv.setUint32(buf.length - 4, ml >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);

  for (let offset = 0; offset < buf.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getInt32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (n << 1) | (n >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f = 0;
      let k = 0;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0 >>> 0, false);
  odv.setUint32(4, h1 >>> 0, false);
  odv.setUint32(8, h2 >>> 0, false);
  odv.setUint32(12, h3 >>> 0, false);
  odv.setUint32(16, h4 >>> 0, false);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function writeUleb128(out: number[], value: number) {
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
}

function encodeMutf8String(str: string): Uint8Array {
  const utf8 = new TextEncoder().encode(str);
  const lenBytes: number[] = [];
  writeUleb128(lenBytes, str.length);
  const res = new Uint8Array(lenBytes.length + utf8.length + 1);
  res.set(lenBytes, 0);
  res.set(utf8, lenBytes.length);
  res[res.length - 1] = 0;
  return res;
}

function compareUtf16CodeUnits(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return new Uint8Array(digest);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const copy = new Uint8Array(data.length);
    copy.set(data);
    void writer.write(copy);
    void writer.close();
    const ab = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(ab);
  } catch {
    return null;
  }
}

// ---------- DER / ASN.1 HELPERS FOR X.509 & PKCS#7 (CERT.RSA) ----------
function derLen(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, ...contents: Uint8Array[]): Uint8Array {
  const body = concatBytes(...contents);
  return concatBytes(new Uint8Array([tag]), derLen(body.length), body);
}

function derInt(value: number | Uint8Array): Uint8Array {
  if (typeof value === 'number') {
    if (value === 0) return derTlv(0x02, new Uint8Array([0]));
    const bytes: number[] = [];
    let n = value;
    while (n > 0) {
      bytes.unshift(n & 0xff);
      n >>>= 8;
    }
    if (bytes[0] & 0x80) bytes.unshift(0);
    return derTlv(0x02, new Uint8Array(bytes));
  }
  let start = 0;
  while (start < value.length - 1 && value[start] === 0 && (value[start + 1] & 0x80) === 0) {
    start++;
  }
  const sliced = value.subarray(start);
  const prefixed = (sliced[0] & 0x80) !== 0 ? concatBytes(new Uint8Array([0]), sliced) : sliced;
  return derTlv(0x02, prefixed);
}

function derOid(oidNums: number[]): Uint8Array {
  const out: number[] = [oidNums[0] * 40 + oidNums[1]];
  for (let i = 2; i < oidNums.length; i++) {
    let val = oidNums[i];
    if (val === 0) {
      out.push(0);
    } else {
      const sub: number[] = [];
      while (val > 0) {
        sub.unshift(val & 0x7f);
        val >>>= 7;
      }
      for (let j = 0; j < sub.length - 1; j++) sub[j] |= 0x80;
      out.push(...sub);
    }
  }
  return derTlv(0x06, new Uint8Array(out));
}

function derUtf8Str(s: string): Uint8Array {
  return derTlv(0x0c, new TextEncoder().encode(s));
}

function derUtcTime(date: Date): Uint8Array {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yy = pad(date.getUTCFullYear() % 100);
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return derTlv(0x17, new TextEncoder().encode(`${yy}${mm}${dd}${hh}${mi}${ss}Z`));
}

// ---------- BINARY STRING POOL (UTF-16LE FOR AXML & RESOURCES.ARSC) ----------
function buildUtf16StringPool(strings: string[]): Uint8Array {
  const encodedStrings: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  for (const s of strings) {
    offsets.push(cursor);
    const entry = new Uint8Array(2 + s.length * 2 + 2);
    const dv = new DataView(entry.buffer);
    dv.setUint16(0, s.length, true);
    for (let i = 0; i < s.length; i++) {
      dv.setUint16(2 + i * 2, s.charCodeAt(i), true);
    }
    dv.setUint16(2 + s.length * 2, 0, true);
    encodedStrings.push(entry);
    cursor += entry.length;
  }

  const headerSize = 28;
  const offsetsSize = strings.length * 4;
  const stringsStart = headerSize + offsetsSize;
  const rawTotal = stringsStart + cursor;
  const paddedTotal = (rawTotal + 3) & ~3;

  const buf = new Uint8Array(paddedTotal);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0x0001, true); // RES_STRING_POOL_TYPE
  dv.setUint16(2, headerSize, true);
  dv.setUint32(4, paddedTotal, true);
  dv.setUint32(8, strings.length, true);
  dv.setUint32(12, 0, true); // styleCount
  dv.setUint32(16, 0, true); // flags = UTF-16LE
  dv.setUint32(20, stringsStart, true);
  dv.setUint32(24, 0, true); // stylesStart

  for (let i = 0; i < offsets.length; i++) {
    dv.setUint32(headerSize + i * 4, offsets[i], true);
  }
  let pos = stringsStart;
  for (const entry of encodedStrings) {
    buf.set(entry, pos);
    pos += entry.length;
  }
  return buf;
}

// ---------- 1. COMPILED BINARY ANDROIDMANIFEST.XML (AXML) ----------
export function buildBinaryAndroidManifest(options: {
  packageName: string;
  versionCode: number;
  versionName: string;
  minSdkVersion: number;
  targetSdkVersion: number;
}): Uint8Array {
  const attrEntries: Array<[string, number]> = [
    ['theme', 0x01010000],
    ['label', 0x01010001],
    ['icon', 0x01010002],
    ['name', 0x01010003],
    ['exported', 0x01010010],
    ['screenOrientation', 0x0101001e],
    ['configChanges', 0x0101001f],
    ['minSdkVersion', 0x0101020c],
    ['versionCode', 0x0101021b],
    ['versionName', 0x0101021c],
    ['targetSdkVersion', 0x01010270],
    ['allowBackup', 0x01010280],
    ['hardwareAccelerated', 0x010102d3],
    ['usesCleartextTraffic', 0x010104ec],
  ];

  const strings: string[] = attrEntries.map((e) => e[0]);
  const resIds: number[] = attrEntries.map((e) => e[1]);
  const strMap = new Map<string, number>();
  strings.forEach((s, i) => strMap.set(s, i));
  const intern = (s: string): number => {
    const existing = strMap.get(s);
    if (existing !== undefined) return existing;
    const idx = strings.length;
    strings.push(s);
    strMap.set(s, idx);
    return idx;
  };

  const NS_PREFIX = 'android';
  const NS_URI = 'http://schemas.android.com/apk/res/android';
  const MAIN_ACTIVITY = `${options.packageName}.MainActivity`;

  const nsPrefixIdx = intern(NS_PREFIX);
  const nsUriIdx = intern(NS_URI);
  intern('manifest');
  intern('package');
  intern(options.packageName);
  intern(options.versionName);
  intern('uses-sdk');
  intern('uses-permission');
  intern('android.permission.INTERNET');
  intern('android.permission.MODIFY_AUDIO_SETTINGS');
  intern('android.permission.RECORD_AUDIO');
  intern('android.permission.WAKE_LOCK');
  intern('application');
  intern('activity');
  intern(MAIN_ACTIVITY);
  intern('intent-filter');
  intern('action');
  intern('android.intent.action.MAIN');
  intern('category');
  intern('android.intent.category.LAUNCHER');

  const stringPoolChunk = buildUtf16StringPool(strings);

  const resMapChunk = new Uint8Array(8 + resIds.length * 4);
  {
    const dv = new DataView(resMapChunk.buffer);
    dv.setUint16(0, 0x0180, true); // RES_XML_RESOURCE_MAP_TYPE
    dv.setUint16(2, 8, true);
    dv.setUint32(4, resMapChunk.length, true);
    for (let i = 0; i < resIds.length; i++) {
      dv.setUint32(8 + i * 4, resIds[i], true);
    }
  }

  const xmlNodes: Uint8Array[] = [];
  let lineNum = 2;

  const pushStartNamespace = () => {
    const chunk = new Uint8Array(24);
    const dv = new DataView(chunk.buffer);
    dv.setUint16(0, 0x0100, true);
    dv.setUint16(2, 16, true);
    dv.setUint32(4, 24, true);
    dv.setUint32(8, lineNum++, true);
    dv.setUint32(12, 0xffffffff, true);
    dv.setUint32(16, nsPrefixIdx, true);
    dv.setUint32(20, nsUriIdx, true);
    xmlNodes.push(chunk);
  };

  const pushEndNamespace = () => {
    const chunk = new Uint8Array(24);
    const dv = new DataView(chunk.buffer);
    dv.setUint16(0, 0x0101, true);
    dv.setUint16(2, 16, true);
    dv.setUint32(4, 24, true);
    dv.setUint32(8, lineNum++, true);
    dv.setUint32(12, 0xffffffff, true);
    dv.setUint32(16, nsPrefixIdx, true);
    dv.setUint32(20, nsUriIdx, true);
    xmlNodes.push(chunk);
  };

  interface XmlAttr {
    ns: number;
    name: string;
    type: number;
    value: number | string;
  }

  const startEl = (tag: string, attrs: XmlAttr[]) => {
    const chunkSize = 36 + attrs.length * 20;
    const chunk = new Uint8Array(chunkSize);
    const dv = new DataView(chunk.buffer);
    dv.setUint16(0, 0x0102, true);
    dv.setUint16(2, 16, true);
    dv.setUint32(4, chunkSize, true);
    dv.setUint32(8, lineNum++, true);
    dv.setUint32(12, 0xffffffff, true);
    dv.setUint32(16, 0xffffffff, true);
    dv.setUint32(20, intern(tag), true);
    dv.setUint16(24, 20, true);
    dv.setUint16(26, 20, true);
    dv.setUint16(28, attrs.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);

    attrs.forEach((attr, idx) => {
      const off = 36 + idx * 20;
      const nameIdx = intern(attr.name);
      const isStr = attr.type === 0x03;
      const strIdx = isStr ? intern(String(attr.value)) : 0xffffffff;
      const dataVal = isStr ? strIdx : Number(attr.value) >>> 0;

      dv.setUint32(off + 0, attr.ns >>> 0, true);
      dv.setUint32(off + 4, nameIdx, true);
      dv.setUint32(off + 8, strIdx, true);
      dv.setUint16(off + 12, 8, true);
      dv.setUint8(off + 14, 0);
      dv.setUint8(off + 15, attr.type);
      dv.setUint32(off + 16, dataVal, true);
    });

    xmlNodes.push(chunk);
  };

  const endEl = (tag: string) => {
    const chunk = new Uint8Array(24);
    const dv = new DataView(chunk.buffer);
    dv.setUint16(0, 0x0103, true);
    dv.setUint16(2, 16, true);
    dv.setUint32(4, 24, true);
    dv.setUint32(8, lineNum++, true);
    dv.setUint32(12, 0xffffffff, true);
    dv.setUint32(16, 0xffffffff, true);
    dv.setUint32(20, intern(tag), true);
    xmlNodes.push(chunk);
  };

  pushStartNamespace();
  startEl('manifest', [
    { ns: nsUriIdx, name: 'versionCode', type: 0x10, value: options.versionCode },
    { ns: nsUriIdx, name: 'versionName', type: 0x03, value: options.versionName },
    { ns: 0xffffffff, name: 'package', type: 0x03, value: options.packageName },
  ]);

  startEl('uses-sdk', [
    { ns: nsUriIdx, name: 'minSdkVersion', type: 0x10, value: options.minSdkVersion },
    { ns: nsUriIdx, name: 'targetSdkVersion', type: 0x10, value: options.targetSdkVersion },
  ]);
  endEl('uses-sdk');

  for (const perm of [
    'android.permission.INTERNET',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.RECORD_AUDIO',
    'android.permission.WAKE_LOCK',
  ]) {
    startEl('uses-permission', [{ ns: nsUriIdx, name: 'name', type: 0x03, value: perm }]);
    endEl('uses-permission');
  }

  startEl('application', [
    { ns: nsUriIdx, name: 'theme', type: 0x01, value: 0x01030007 },
    { ns: nsUriIdx, name: 'label', type: 0x01, value: 0x7f010000 },
    { ns: nsUriIdx, name: 'icon', type: 0x01, value: 0x7f020000 },
    { ns: nsUriIdx, name: 'allowBackup', type: 0x12, value: 0xffffffff },
    { ns: nsUriIdx, name: 'hardwareAccelerated', type: 0x12, value: 0xffffffff },
    { ns: nsUriIdx, name: 'usesCleartextTraffic', type: 0x12, value: 0xffffffff },
  ]);

  startEl('activity', [
    { ns: nsUriIdx, name: 'name', type: 0x03, value: MAIN_ACTIVITY },
    { ns: nsUriIdx, name: 'exported', type: 0x12, value: 0xffffffff },
    { ns: nsUriIdx, name: 'screenOrientation', type: 0x10, value: 6 },
    { ns: nsUriIdx, name: 'configChanges', type: 0x11, value: 0x04a0 },
  ]);

  startEl('intent-filter', []);
  startEl('action', [{ ns: nsUriIdx, name: 'name', type: 0x03, value: 'android.intent.action.MAIN' }]);
  endEl('action');
  startEl('category', [{ ns: nsUriIdx, name: 'name', type: 0x03, value: 'android.intent.category.LAUNCHER' }]);
  endEl('category');
  endEl('intent-filter');

  endEl('activity');
  endEl('application');
  endEl('manifest');
  pushEndNamespace();

  const body = concatBytes(stringPoolChunk, resMapChunk, ...xmlNodes);
  const rootHeader = new Uint8Array(8);
  const rdv = new DataView(rootHeader.buffer);
  rdv.setUint16(0, 0x0003, true);
  rdv.setUint16(2, 8, true);
  rdv.setUint32(4, 8 + body.length, true);

  return concatBytes(rootHeader, body);
}

// ---------- 2. COMPILED RESOURCES.ARSC ----------
export function buildResourcesArsc(packageName: string, appName: string, iconPath: string): Uint8Array {
  const globalPool = buildUtf16StringPool([appName, iconPath]);
  const typePool = buildUtf16StringPool(['string', 'mipmap']);
  const keyPool = buildUtf16StringPool(['app_name', 'ic_launcher']);

  const buildSingleEntryType = (typeId: number, keyIdx: number, globalStrIdx: number): Uint8Array => {
    const spec = new Uint8Array(20);
    {
      const dv = new DataView(spec.buffer);
      dv.setUint16(0, 0x0202, true);
      dv.setUint16(2, 16, true);
      dv.setUint32(4, 20, true);
      dv.setUint8(8, typeId);
      dv.setUint32(12, 1, true);
      dv.setUint32(16, 0, true);
    }

    const headerSize = 84;
    const entriesStart = headerSize + 4;
    const entrySize = 16;
    const typeChunkSize = entriesStart + entrySize;
    const typeChunk = new Uint8Array(typeChunkSize);
    {
      const dv = new DataView(typeChunk.buffer);
      dv.setUint16(0, 0x0201, true);
      dv.setUint16(2, headerSize, true);
      dv.setUint32(4, typeChunkSize, true);
      dv.setUint8(8, typeId);
      dv.setUint32(12, 1, true);
      dv.setUint32(16, entriesStart, true);
      dv.setUint32(20, 64, true);

      dv.setUint32(headerSize, 0, true);
      dv.setUint16(entriesStart + 0, 8, true);
      dv.setUint16(entriesStart + 2, 0, true);
      dv.setUint32(entriesStart + 4, keyIdx, true);
      dv.setUint16(entriesStart + 8, 8, true);
      dv.setUint8(entriesStart + 10, 0);
      dv.setUint8(entriesStart + 11, 0x03);
      dv.setUint32(entriesStart + 12, globalStrIdx, true);
    }

    return concatBytes(spec, typeChunk);
  };

  const stringType = buildSingleEntryType(1, 0, 0);
  const mipmapType = buildSingleEntryType(2, 1, 1);

  const pkgHeaderSize = 288;
  const typeStringsOff = pkgHeaderSize;
  const keyStringsOff = typeStringsOff + typePool.length;
  const pkgBody = concatBytes(typePool, keyPool, stringType, mipmapType);
  const pkgTotal = pkgHeaderSize + pkgBody.length;

  const pkgHeader = new Uint8Array(pkgHeaderSize);
  {
    const dv = new DataView(pkgHeader.buffer);
    dv.setUint16(0, 0x0200, true);
    dv.setUint16(2, pkgHeaderSize, true);
    dv.setUint32(4, pkgTotal, true);
    dv.setUint32(8, 0x7f, true);
    for (let i = 0; i < Math.min(127, packageName.length); i++) {
      dv.setUint16(12 + i * 2, packageName.charCodeAt(i), true);
    }
    dv.setUint32(268, typeStringsOff, true);
    dv.setUint32(272, 2, true);
    dv.setUint32(276, keyStringsOff, true);
    dv.setUint32(280, 2, true);
    dv.setUint32(284, 0, true);
  }

  const pkgChunk = concatBytes(pkgHeader, pkgBody);
  const totalSize = 12 + globalPool.length + pkgChunk.length;
  const tableHeader = new Uint8Array(12);
  {
    const dv = new DataView(tableHeader.buffer);
    dv.setUint16(0, 0x0002, true);
    dv.setUint16(2, 12, true);
    dv.setUint32(4, totalSize, true);
    dv.setUint32(8, 1, true);
  }

  return concatBytes(tableHeader, globalPool, pkgChunk);
}

// ---------- 3. MULTI-CLASS OFFLINE DALVIK EXECUTABLE (CLASSES.DEX 035) ----------
export function buildClassesDex(packageName: string): Uint8Array {
  const pkgSlash = packageName.replace(/\./g, '/');
  const mainClass = `L${pkgSlash}/MainActivity;`;
  const clientClass = `L${pkgSlash}/OfflineClient;`;
  const chromeClass = `L${pkgSlash}/OfflineChromeClient;`;

  const neededStrings = new Set<string>([
    '*/*',
    '*',
    '/',
    '.css',
    '.html',
    '.ico',
    '.js',
    '.json',
    '.mjs',
    '.png',
    '.svg',
    '.wasm',
    '.webmanifest',
    '<init>',
    'Access-Control-Allow-Origin',
    'I',
    'L',
    'LI',
    'LL',
    'LLL',
    'Landroid/app/Activity;',
    'Landroid/content/Context;',
    'Landroid/content/Intent;',
    'Landroid/content/res/AssetManager;',
    'Landroid/net/Uri;',
    'Landroid/os/Bundle;',
    'Landroid/view/View;',
    'Landroid/webkit/ValueCallback;',
    'Landroid/webkit/WebChromeClient$FileChooserParams;',
    'Landroid/webkit/WebChromeClient;',
    'Landroid/webkit/WebResourceRequest;',
    'Landroid/webkit/WebResourceResponse;',
    'Landroid/webkit/WebSettings;',
    'Landroid/webkit/WebView;',
    'Landroid/webkit/WebViewClient;',
    mainClass,
    clientClass,
    chromeClass,
    'Ljava/io/InputStream;',
    'Ljava/lang/Object;',
    'Ljava/lang/String;',
    'Ljava/util/HashMap;',
    'Ljava/util/Map;',
    'OK',
    'UTF-8',
    'V',
    'VI',
    'VIIL',
    'VL',
    'VLL',
    'VLLIL',
    'VLLILL',
    'VZ',
    'Z',
    'ZL',
    'ZLL',
    'ZLLL',
    '[Landroid/net/Uri;',
    'appassets.androidplatform.net',
    'application/javascript',
    'application/json',
    'application/manifest+json',
    'application/octet-stream',
    'application/wasm',
    'assets',
    'canGoBack',
    'concat',
    'createIntent',
    'endsWith',
    'equals',
    'filePathCallback',
    'getAssets',
    'getHost',
    'getPath',
    'getSettings',
    'getUrl',
    'goBack',
    'https://appassets.androidplatform.net/index.html',
    'image/png',
    'image/svg+xml',
    'image/x-icon',
    'index.html',
    'length',
    'loadUrl',
    'onActivityResult',
    'onBackPressed',
    'onCreate',
    'onReceiveValue',
    'onShowFileChooser',
    'open',
    'openFileChooser',
    'parseResult',
    'put',
    'setAllowFileAccess',
    'setContentView',
    'setDomStorageEnabled',
    'setJavaScriptEnabled',
    'setMediaPlaybackRequiresUserGesture',
    'setType',
    'setVolumeControlStream',
    'setWebChromeClient',
    'setWebViewClient',
    'shouldInterceptRequest',
    'startActivityForResult',
    'startsWith',
    'substring',
    'text/css',
    'text/html',
    'webView',
    'www/',
    'activity',
  ]);

  const toShortyChar = (desc: string): string => {
    if (desc.startsWith('L') || desc.startsWith('[')) return 'L';
    return desc;
  };

  interface ProtoDef {
    shorty: string;
    ret: string;
    params: string[];
  }

  const makeProto = (ret: string, params: string[]): ProtoDef => {
    const shorty = toShortyChar(ret) + params.map(toShortyChar).join('');
    neededStrings.add(shorty);
    neededStrings.add(ret);
    params.forEach((p) => neededStrings.add(p));
    return { shorty, ret, params };
  };

  const rawProtos: ProtoDef[] = [
    makeProto('I', []),
    makeProto('Landroid/content/Intent;', []),
    makeProto('Landroid/content/Intent;', ['Ljava/lang/String;']),
    makeProto('Landroid/content/res/AssetManager;', []),
    makeProto('Landroid/net/Uri;', []),
    makeProto('Landroid/webkit/WebSettings;', []),
    makeProto('Landroid/webkit/WebResourceResponse;', ['Landroid/webkit/WebView;', 'Landroid/webkit/WebResourceRequest;']),
    makeProto('Ljava/io/InputStream;', ['Ljava/lang/String;']),
    makeProto('Ljava/lang/Object;', ['Ljava/lang/Object;', 'Ljava/lang/Object;']),
    makeProto('Ljava/lang/String;', []),
    makeProto('Ljava/lang/String;', ['I']),
    makeProto('Ljava/lang/String;', ['Ljava/lang/String;']),
    makeProto('V', []),
    makeProto('V', ['I']),
    makeProto('V', ['I', 'I', 'Landroid/content/Intent;']),
    makeProto('V', ['Landroid/content/Context;']),
    makeProto('V', ['Landroid/content/Intent;', 'I']),
    makeProto('V', ['Landroid/os/Bundle;']),
    makeProto('V', ['Landroid/view/View;']),
    makeProto('V', ['Landroid/webkit/WebChromeClient;']),
    makeProto('V', ['Landroid/webkit/WebViewClient;']),
    makeProto('V', [mainClass]),
    makeProto('V', ['Ljava/lang/Object;']),
    makeProto('V', ['Ljava/lang/String;']),
    makeProto('V', ['Ljava/lang/String;', 'Ljava/lang/String;', 'I', 'Ljava/lang/String;', 'Ljava/util/Map;', 'Ljava/io/InputStream;']),
    makeProto('V', ['Z']),
    makeProto('Z', []),
    makeProto('Z', ['Landroid/webkit/ValueCallback;', 'Landroid/webkit/WebChromeClient$FileChooserParams;']),
    makeProto('Z', ['Landroid/webkit/WebView;', 'Landroid/webkit/ValueCallback;', 'Landroid/webkit/WebChromeClient$FileChooserParams;']),
    makeProto('Z', ['Ljava/lang/Object;']),
    makeProto('Z', ['Ljava/lang/String;']),
    makeProto('[Landroid/net/Uri;', ['I', 'Landroid/content/Intent;']),
  ];

  const sortedStrings = Array.from(neededStrings).sort(compareUtf16CodeUnits);
  const sIdx = (s: string) => {
    const idx = sortedStrings.indexOf(s);
    if (idx < 0) throw new Error(`Missing DEX string: ${s}`);
    return idx;
  };

  const typeDescriptors = [
    'I',
    'Landroid/app/Activity;',
    'Landroid/content/Context;',
    'Landroid/content/Intent;',
    'Landroid/content/res/AssetManager;',
    'Landroid/net/Uri;',
    'Landroid/os/Bundle;',
    'Landroid/view/View;',
    'Landroid/webkit/ValueCallback;',
    'Landroid/webkit/WebChromeClient$FileChooserParams;',
    'Landroid/webkit/WebChromeClient;',
    'Landroid/webkit/WebResourceRequest;',
    'Landroid/webkit/WebResourceResponse;',
    'Landroid/webkit/WebSettings;',
    'Landroid/webkit/WebView;',
    'Landroid/webkit/WebViewClient;',
    mainClass,
    clientClass,
    chromeClass,
    'Ljava/io/InputStream;',
    'Ljava/lang/Object;',
    'Ljava/lang/String;',
    'Ljava/util/HashMap;',
    'Ljava/util/Map;',
    'V',
    'Z',
    '[Landroid/net/Uri;',
  ].sort((a, b) => sIdx(a) - sIdx(b));

  const tIdx = (desc: string) => {
    const idx = typeDescriptors.indexOf(desc);
    if (idx < 0) throw new Error(`Missing DEX type: ${desc}`);
    return idx;
  };

  rawProtos.sort((a, b) => {
    const rDiff = tIdx(a.ret) - tIdx(b.ret);
    if (rDiff !== 0) return rDiff;
    const minP = Math.min(a.params.length, b.params.length);
    for (let i = 0; i < minP; i++) {
      const pDiff = tIdx(a.params[i]) - tIdx(b.params[i]);
      if (pDiff !== 0) return pDiff;
    }
    return a.params.length - b.params.length;
  });

  const protoIdx = (ret: string, params: string[]) => {
    const idx = rawProtos.findIndex(
      (p) => p.ret === ret && p.params.length === params.length && p.params.every((x, i) => x === params[i])
    );
    if (idx < 0) throw new Error(`Missing DEX proto: (${params.join('')})${ret}`);
    return idx;
  };

  interface FieldDef {
    cls: string;
    name: string;
    type: string;
  }

  const fields: FieldDef[] = [
    { cls: mainClass, name: 'filePathCallback', type: 'Landroid/webkit/ValueCallback;' },
    { cls: mainClass, name: 'webView', type: 'Landroid/webkit/WebView;' },
    { cls: clientClass, name: 'assets', type: 'Landroid/content/res/AssetManager;' },
    { cls: chromeClass, name: 'activity', type: mainClass },
  ];

  fields.sort((a, b) => {
    const c = tIdx(a.cls) - tIdx(b.cls);
    if (c !== 0) return c;
    const n = sIdx(a.name) - sIdx(b.name);
    if (n !== 0) return n;
    return tIdx(a.type) - tIdx(b.type);
  });

  const fIdx = (cls: string, name: string) => {
    const idx = fields.findIndex((f) => f.cls === cls && f.name === name);
    if (idx < 0) throw new Error(`Missing DEX field: ${cls}.${name}`);
    return idx;
  };

  interface MethodDef {
    cls: string;
    name: string;
    ret: string;
    params: string[];
  }

  const methods: MethodDef[] = [
    { cls: 'Landroid/app/Activity;', name: '<init>', ret: 'V', params: [] },
    { cls: 'Landroid/app/Activity;', name: 'onActivityResult', ret: 'V', params: ['I', 'I', 'Landroid/content/Intent;'] },
    { cls: 'Landroid/app/Activity;', name: 'onBackPressed', ret: 'V', params: [] },
    { cls: 'Landroid/app/Activity;', name: 'onCreate', ret: 'V', params: ['Landroid/os/Bundle;'] },
    { cls: 'Landroid/app/Activity;', name: 'setContentView', ret: 'V', params: ['Landroid/view/View;'] },
    { cls: 'Landroid/app/Activity;', name: 'setVolumeControlStream', ret: 'V', params: ['I'] },
    { cls: 'Landroid/app/Activity;', name: 'startActivityForResult', ret: 'V', params: ['Landroid/content/Intent;', 'I'] },
    { cls: 'Landroid/content/Context;', name: 'getAssets', ret: 'Landroid/content/res/AssetManager;', params: [] },
    { cls: 'Landroid/content/Intent;', name: 'setType', ret: 'Landroid/content/Intent;', params: ['Ljava/lang/String;'] },
    { cls: 'Landroid/content/res/AssetManager;', name: 'open', ret: 'Ljava/io/InputStream;', params: ['Ljava/lang/String;'] },
    { cls: 'Landroid/net/Uri;', name: 'getHost', ret: 'Ljava/lang/String;', params: [] },
    { cls: 'Landroid/net/Uri;', name: 'getPath', ret: 'Ljava/lang/String;', params: [] },
    { cls: 'Landroid/webkit/ValueCallback;', name: 'onReceiveValue', ret: 'V', params: ['Ljava/lang/Object;'] },
    { cls: 'Landroid/webkit/WebChromeClient$FileChooserParams;', name: 'createIntent', ret: 'Landroid/content/Intent;', params: [] },
    { cls: 'Landroid/webkit/WebChromeClient$FileChooserParams;', name: 'parseResult', ret: '[Landroid/net/Uri;', params: ['I', 'Landroid/content/Intent;'] },
    { cls: 'Landroid/webkit/WebChromeClient;', name: '<init>', ret: 'V', params: [] },
    { cls: 'Landroid/webkit/WebResourceRequest;', name: 'getUrl', ret: 'Landroid/net/Uri;', params: [] },
    { cls: 'Landroid/webkit/WebResourceResponse;', name: '<init>', ret: 'V', params: ['Ljava/lang/String;', 'Ljava/lang/String;', 'I', 'Ljava/lang/String;', 'Ljava/util/Map;', 'Ljava/io/InputStream;'] },
    { cls: 'Landroid/webkit/WebSettings;', name: 'setAllowFileAccess', ret: 'V', params: ['Z'] },
    { cls: 'Landroid/webkit/WebSettings;', name: 'setDomStorageEnabled', ret: 'V', params: ['Z'] },
    { cls: 'Landroid/webkit/WebSettings;', name: 'setJavaScriptEnabled', ret: 'V', params: ['Z'] },
    { cls: 'Landroid/webkit/WebSettings;', name: 'setMediaPlaybackRequiresUserGesture', ret: 'V', params: ['Z'] },
    { cls: 'Landroid/webkit/WebView;', name: '<init>', ret: 'V', params: ['Landroid/content/Context;'] },
    { cls: 'Landroid/webkit/WebView;', name: 'canGoBack', ret: 'Z', params: [] },
    { cls: 'Landroid/webkit/WebView;', name: 'getSettings', ret: 'Landroid/webkit/WebSettings;', params: [] },
    { cls: 'Landroid/webkit/WebView;', name: 'goBack', ret: 'V', params: [] },
    { cls: 'Landroid/webkit/WebView;', name: 'loadUrl', ret: 'V', params: ['Ljava/lang/String;'] },
    { cls: 'Landroid/webkit/WebView;', name: 'setWebChromeClient', ret: 'V', params: ['Landroid/webkit/WebChromeClient;'] },
    { cls: 'Landroid/webkit/WebView;', name: 'setWebViewClient', ret: 'V', params: ['Landroid/webkit/WebViewClient;'] },
    { cls: 'Landroid/webkit/WebViewClient;', name: '<init>', ret: 'V', params: [] },
    { cls: mainClass, name: '<init>', ret: 'V', params: [] },
    { cls: mainClass, name: 'onActivityResult', ret: 'V', params: ['I', 'I', 'Landroid/content/Intent;'] },
    { cls: mainClass, name: 'onBackPressed', ret: 'V', params: [] },
    { cls: mainClass, name: 'onCreate', ret: 'V', params: ['Landroid/os/Bundle;'] },
    { cls: mainClass, name: 'openFileChooser', ret: 'Z', params: ['Landroid/webkit/ValueCallback;', 'Landroid/webkit/WebChromeClient$FileChooserParams;'] },
    { cls: clientClass, name: '<init>', ret: 'V', params: ['Landroid/content/Context;'] },
    { cls: clientClass, name: 'shouldInterceptRequest', ret: 'Landroid/webkit/WebResourceResponse;', params: ['Landroid/webkit/WebView;', 'Landroid/webkit/WebResourceRequest;'] },
    { cls: chromeClass, name: '<init>', ret: 'V', params: [mainClass] },
    { cls: chromeClass, name: 'onShowFileChooser', ret: 'Z', params: ['Landroid/webkit/WebView;', 'Landroid/webkit/ValueCallback;', 'Landroid/webkit/WebChromeClient$FileChooserParams;'] },
    { cls: 'Ljava/lang/String;', name: 'concat', ret: 'Ljava/lang/String;', params: ['Ljava/lang/String;'] },
    { cls: 'Ljava/lang/String;', name: 'endsWith', ret: 'Z', params: ['Ljava/lang/String;'] },
    { cls: 'Ljava/lang/String;', name: 'equals', ret: 'Z', params: ['Ljava/lang/Object;'] },
    { cls: 'Ljava/lang/String;', name: 'length', ret: 'I', params: [] },
    { cls: 'Ljava/lang/String;', name: 'startsWith', ret: 'Z', params: ['Ljava/lang/String;'] },
    { cls: 'Ljava/lang/String;', name: 'substring', ret: 'Ljava/lang/String;', params: ['I'] },
    { cls: 'Ljava/util/HashMap;', name: '<init>', ret: 'V', params: [] },
    { cls: 'Ljava/util/HashMap;', name: 'put', ret: 'Ljava/lang/Object;', params: ['Ljava/lang/Object;', 'Ljava/lang/Object;'] },
  ];

  methods.sort((a, b) => {
    const c = tIdx(a.cls) - tIdx(b.cls);
    if (c !== 0) return c;
    const n = sIdx(a.name) - sIdx(b.name);
    if (n !== 0) return n;
    return protoIdx(a.ret, a.params) - protoIdx(b.ret, b.params);
  });

  const mIdx = (cls: string, name: string, ret: string, params: string[]) => {
    const idx = methods.findIndex(
      (m) =>
        m.cls === cls &&
        m.name === name &&
        m.ret === ret &&
        m.params.length === params.length &&
        m.params.every((x, i) => x === params[i])
    );
    if (idx < 0) throw new Error(`Missing DEX method: ${cls}.${name}`);
    return idx;
  };

  // Dalvik tiny assembler helpers
  class InsnBuilder {
    public units: number[] = [];
    private labels = new Map<string, number>();
    private fixups: Array<{ unitPos: number; instrStart: number; label: string; width: 16 }> = [];
    public get pos() {
      return this.units.length;
    }
    public label(name: string) {
      this.labels.set(name, this.units.length);
    }
    public emit(...u: number[]) {
      for (const x of u) this.units.push(x & 0xffff);
    }
    public invoke35c(op: number, m: number, regs: number[]) {
      const cnt = regs.length;
      const r0 = regs[0] || 0;
      const r1 = regs[1] || 0;
      const r2 = regs[2] || 0;
      const r3 = regs[3] || 0;
      const r4 = regs[4] || 0;
      this.emit(
        ((cnt & 0xf) << 12) | ((r4 & 0xf) << 8) | op,
        m,
        ((r3 & 0xf) << 12) | ((r2 & 0xf) << 8) | ((r1 & 0xf) << 4) | (r0 & 0xf)
      );
    }
    public invokeRange(op: number, m: number, firstReg: number, count: number) {
      this.emit(((count & 0xff) << 8) | op, m, firstReg);
    }
    public branch21t(op: number, reg: number, targetLabel: string) {
      const instrStart = this.units.length;
      this.emit(((reg & 0xff) << 8) | op);
      const fixPos = this.units.length;
      this.emit(0);
      this.fixups.push({ unitPos: fixPos, instrStart, label: targetLabel, width: 16 });
    }
    public branch22t(op: number, rA: number, rB: number, targetLabel: string) {
      const instrStart = this.units.length;
      this.emit(((rB & 0xf) << 12) | ((rA & 0xf) << 8) | op);
      const fixPos = this.units.length;
      this.emit(0);
      this.fixups.push({ unitPos: fixPos, instrStart, label: targetLabel, width: 16 });
    }
    public goto16(targetLabel: string) {
      const instrStart = this.units.length;
      this.emit(0x0029);
      const fixPos = this.units.length;
      this.emit(0);
      this.fixups.push({ unitPos: fixPos, instrStart, label: targetLabel, width: 16 });
    }
    public resolve(name: string): number {
      const v = this.labels.get(name);
      if (v === undefined) throw new Error(`Missing DEX label: ${name}`);
      return v;
    }
    public finalize(): number[] {
      for (const fx of this.fixups) {
        const target = this.resolve(fx.label);
        const rel = target - fx.instrStart;
        if (rel < -32768 || rel > 32767) throw new Error(`Branch overflow for ${fx.label}: ${rel}`);
        this.units[fx.unitPos] = rel & 0xffff;
      }
      return this.units;
    }
  }

  interface CodeTry {
    startAddr: number;
    endAddr: number;
    catchAddr: number;
  }

  const buildCodeItem = (regs: number, ins: number, outs: number, insns: number[], tryItem?: CodeTry): Uint8Array => {
    const triesSize = tryItem ? 1 : 0;
    const padUnits = triesSize > 0 && insns.length % 2 === 1 ? 1 : 0;
    let catchHandlerBytes: number[] = [];
    if (tryItem) {
      catchHandlerBytes = [0x01, 0x00]; // list size=1, handler[0].size=0 (catch_all only)
      writeUleb128(catchHandlerBytes, tryItem.catchAddr);
    }
    const rawSize = 16 + (insns.length + padUnits) * 2 + triesSize * 8 + catchHandlerBytes.length;
    const padded = (rawSize + 3) & ~3;
    const buf = new Uint8Array(padded);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, regs, true);
    dv.setUint16(2, ins, true);
    dv.setUint16(4, outs, true);
    dv.setUint16(6, triesSize, true);
    dv.setUint32(8, 0, true);
    dv.setUint32(12, insns.length, true);
    for (let i = 0; i < insns.length; i++) {
      dv.setUint16(16 + i * 2, insns[i] & 0xffff, true);
    }
    if (tryItem) {
      const tryOff = 16 + (insns.length + padUnits) * 2;
      dv.setUint32(tryOff + 0, tryItem.startAddr, true);
      dv.setUint16(tryOff + 4, tryItem.endAddr - tryItem.startAddr, true);
      dv.setUint16(tryOff + 6, 1, true); // offset after 1-byte uleb128(1)
      buf.set(catchHandlerBytes, tryOff + 8);
    }
    return buf;
  };

  // --- Method bytecodes ---
  // 1. MainActivity.<init>()V (regs=1, ins=1, outs=1; v0=this)
  const mainInitB = new InsnBuilder();
  mainInitB.invoke35c(0x70, mIdx('Landroid/app/Activity;', '<init>', 'V', []), [0]);
  mainInitB.emit(0x000e);

  // 2. MainActivity.onActivityResult(I,I,Intent)V (regs=6, ins=4, outs=4; v2=this,v3=req,v4=res,v5=data)
  const mainActivityResB = new InsnBuilder();
  mainActivityResB.invoke35c(0x6f, mIdx('Landroid/app/Activity;', 'onActivityResult', 'V', ['I', 'I', 'Landroid/content/Intent;']), [2, 3, 4, 5]);
  mainActivityResB.emit((2 << 12) | (0 << 8) | 0x54, fIdx(mainClass, 'filePathCallback')); // iget-object v0, v2
  mainActivityResB.branch21t(0x38, 0, 'done'); // if-eqz v0, :done
  mainActivityResB.emit((1 << 8) | 0x13, 1001); // const/16 v1, 1001
  mainActivityResB.branch22t(0x33, 3, 1, 'done'); // if-ne v3, v1, :done
  mainActivityResB.invoke35c(0x71, mIdx('Landroid/webkit/WebChromeClient$FileChooserParams;', 'parseResult', '[Landroid/net/Uri;', ['I', 'Landroid/content/Intent;']), [4, 5]);
  mainActivityResB.emit((1 << 8) | 0x0c); // move-result-object v1
  mainActivityResB.invoke35c(0x72, mIdx('Landroid/webkit/ValueCallback;', 'onReceiveValue', 'V', ['Ljava/lang/Object;']), [0, 1]);
  mainActivityResB.emit((0 << 8) | 0x12); // const/4 v0, 0
  mainActivityResB.emit((2 << 12) | (0 << 8) | 0x5b, fIdx(mainClass, 'filePathCallback')); // iput-object v0, v2
  mainActivityResB.label('done');
  mainActivityResB.emit(0x000e); // return-void

  // 3. MainActivity.onBackPressed()V (regs=2, ins=1, outs=1; v1=this)
  const mainBackB = new InsnBuilder();
  mainBackB.emit((1 << 12) | (0 << 8) | 0x54, fIdx(mainClass, 'webView')); // iget-object v0, v1
  mainBackB.branch21t(0x38, 0, 'super_back');
  mainBackB.invoke35c(0x6e, mIdx('Landroid/webkit/WebView;', 'canGoBack', 'Z', []), [0]);
  mainBackB.emit((0 << 8) | 0x0a); // move-result v0
  mainBackB.branch21t(0x38, 0, 'super_back');
  mainBackB.emit((1 << 12) | (0 << 8) | 0x54, fIdx(mainClass, 'webView'));
  mainBackB.invoke35c(0x6e, mIdx('Landroid/webkit/WebView;', 'goBack', 'V', []), [0]);
  mainBackB.emit(0x000e);
  mainBackB.label('super_back');
  mainBackB.invoke35c(0x6f, mIdx('Landroid/app/Activity;', 'onBackPressed', 'V', []), [1]);
  mainBackB.emit(0x000e);

  // 4. MainActivity.onCreate(Bundle)V (regs=6, ins=2, outs=2; v4=this, v5=savedInstanceState)
  const mainOnCreateB = new InsnBuilder();
  mainOnCreateB.invoke35c(0x6f, mIdx('Landroid/app/Activity;', 'onCreate', 'V', ['Landroid/os/Bundle;']), [4, 5]);
  mainOnCreateB.emit((3 << 12) | (0 << 8) | 0x12); // const/4 v0, 3 (STREAM_MUSIC)
  mainOnCreateB.invoke35c(0x6e, mIdx('Landroid/app/Activity;', 'setVolumeControlStream', 'V', ['I']), [4, 0]);
  mainOnCreateB.emit((0 << 8) | 0x22, tIdx('Landroid/webkit/WebView;')); // new-instance v0, WebView
  mainOnCreateB.invoke35c(0x70, mIdx('Landroid/webkit/WebView;', '<init>', 'V', ['Landroid/content/Context;']), [0, 4]);
  mainOnCreateB.emit((4 << 12) | (0 << 8) | 0x5b, fIdx(mainClass, 'webView')); // iput-object v0, v4
  mainOnCreateB.invoke35c(0x6e, mIdx('Landroid/webkit/WebView;', 'getSettings', 'Landroid/webkit/WebSettings;', []), [0]);
  mainOnCreateB.emit((1 << 8) | 0x0c); // move-result-object v1
  mainOnCreateB.emit((1 << 12) | (2 << 8) | 0x12); // const/4 v2, 1
  mainOnCreateB.invoke35c(0x6e, mIdx('Landroid/webkit/WebSettings;', 'setJavaScriptEnabled', 'V', ['Z']), [1, 2]);
  mainOnCreateB.invoke35c(0x6e, mIdx('Landroid/webkit/WebSettings;', 'setDomStorageEnabled', 'V', ['Z']), [1, 2]);
  mainOnCreateB.invoke35c(0x6e, mIdx('Landroid/webkit/WebSettings;', 'setAllowFileAccess', 'V', ['Z']), [1, 2]);
  mainOnCreateB.emit((0 << 12) | (2 << 8) | 0x12); // const/4 v2, 0
  mainOnCreateB.invoke35c(0x6e, mIdx('Landroid/webkit/WebSettings;', 'setMediaPlaybackRequiresUserGesture', 'V', ['Z']), [1, 2]);
  mainOnCreateB.emit((2 << 8) | 0x22, tIdx(clientClass)); // new-instance v2, OfflineClient
  mainOnCreateB.invoke35c(0x70, mIdx(clientClass, '<init>', 'V', ['Landroid/content/Context;']), [2, 4]);
  mainOnCreateB.invoke35c(0x6e, mIdx('Landroid/webkit/WebView;', 'setWebViewClient', 'V', ['Landroid/webkit/WebViewClient;']), [0, 2]);
  mainOnCreateB.emit((2 << 8) | 0x22, tIdx(chromeClass)); // new-instance v2, OfflineChromeClient
  mainOnCreateB.invoke35c(0x70, mIdx(chromeClass, '<init>', 'V', [mainClass]), [2, 4]);
  mainOnCreateB.invoke35c(0x6e, mIdx('Landroid/webkit/WebView;', 'setWebChromeClient', 'V', ['Landroid/webkit/WebChromeClient;']), [0, 2]);
  mainOnCreateB.invoke35c(0x6e, mIdx('Landroid/app/Activity;', 'setContentView', 'V', ['Landroid/view/View;']), [4, 0]);
  mainOnCreateB.emit((2 << 8) | 0x1a, sIdx('https://appassets.androidplatform.net/index.html'));
  mainOnCreateB.invoke35c(0x6e, mIdx('Landroid/webkit/WebView;', 'loadUrl', 'V', ['Ljava/lang/String;']), [0, 2]);
  mainOnCreateB.emit(0x000e);

  // 5. MainActivity.openFileChooser(ValueCallback, FileChooserParams)Z (regs=6, ins=3, outs=3; v3=this,v4=cb,v5=params)
  const mainOpenChooserB = new InsnBuilder();
  mainOpenChooserB.emit((3 << 12) | (0 << 8) | 0x54, fIdx(mainClass, 'filePathCallback'));
  mainOpenChooserB.branch21t(0x38, 0, 'store_cb');
  mainOpenChooserB.emit((0 << 12) | (1 << 8) | 0x12); // const/4 v1, 0
  mainOpenChooserB.invoke35c(0x72, mIdx('Landroid/webkit/ValueCallback;', 'onReceiveValue', 'V', ['Ljava/lang/Object;']), [0, 1]);
  mainOpenChooserB.label('store_cb');
  mainOpenChooserB.emit((3 << 12) | (4 << 8) | 0x5b, fIdx(mainClass, 'filePathCallback'));
  const chooserTryStart = mainOpenChooserB.pos;
  mainOpenChooserB.invoke35c(0x6e, mIdx('Landroid/webkit/WebChromeClient$FileChooserParams;', 'createIntent', 'Landroid/content/Intent;', []), [5]);
  mainOpenChooserB.emit((0 << 8) | 0x0c); // move-result-object v0
  mainOpenChooserB.emit((1 << 8) | 0x1a, sIdx('*/*'));
  mainOpenChooserB.invoke35c(0x6e, mIdx('Landroid/content/Intent;', 'setType', 'Landroid/content/Intent;', ['Ljava/lang/String;']), [0, 1]);
  mainOpenChooserB.emit((1 << 8) | 0x13, 1001); // const/16 v1, 1001
  mainOpenChooserB.invoke35c(0x6e, mIdx('Landroid/app/Activity;', 'startActivityForResult', 'V', ['Landroid/content/Intent;', 'I']), [3, 0, 1]);
  mainOpenChooserB.emit((1 << 12) | (0 << 8) | 0x12); // const/4 v0, 1
  mainOpenChooserB.emit((0 << 8) | 0x0f); // return v0
  const chooserTryEnd = mainOpenChooserB.pos;
  const chooserCatchAddr = mainOpenChooserB.pos;
  mainOpenChooserB.emit((0 << 8) | 0x0d); // move-exception v0
  mainOpenChooserB.emit((0 << 12) | (1 << 8) | 0x12); // const/4 v1, 0
  mainOpenChooserB.emit((3 << 12) | (1 << 8) | 0x5b, fIdx(mainClass, 'filePathCallback'));
  mainOpenChooserB.emit((0 << 12) | (0 << 8) | 0x12); // const/4 v0, 0 (false)
  mainOpenChooserB.emit((0 << 8) | 0x0f); // return v0

  // 6. OfflineClient.<init>(Context)V (regs=3, ins=2, outs=1; v1=this, v2=ctx)
  const clientInitB = new InsnBuilder();
  clientInitB.invoke35c(0x70, mIdx('Landroid/webkit/WebViewClient;', '<init>', 'V', []), [1]);
  clientInitB.invoke35c(0x6e, mIdx('Landroid/content/Context;', 'getAssets', 'Landroid/content/res/AssetManager;', []), [2]);
  clientInitB.emit((0 << 8) | 0x0c); // move-result-object v0
  clientInitB.emit((1 << 12) | (0 << 8) | 0x5b, fIdx(clientClass, 'assets'));
  clientInitB.emit(0x000e);

  // 7. OfflineClient.shouldInterceptRequest(WebView, WebResourceRequest)WebResourceResponse
  //    regs=11, ins=3, outs=7; params: v8=this, v9=view, v10=request
  const clientInterceptB = new InsnBuilder();
  const interceptTryStart = clientInterceptB.pos;
  clientInterceptB.invoke35c(0x72, mIdx('Landroid/webkit/WebResourceRequest;', 'getUrl', 'Landroid/net/Uri;', []), [10]);
  clientInterceptB.emit((0 << 8) | 0x0c); // move-result-object v0 (Uri)
  clientInterceptB.branch21t(0x38, 0, 'ret_null');
  clientInterceptB.invoke35c(0x6e, mIdx('Landroid/net/Uri;', 'getHost', 'Ljava/lang/String;', []), [0]);
  clientInterceptB.emit((1 << 8) | 0x0c); // move-result-object v1 (host)
  clientInterceptB.emit((2 << 8) | 0x1a, sIdx('appassets.androidplatform.net'));
  clientInterceptB.invoke35c(0x6e, mIdx('Ljava/lang/String;', 'equals', 'Z', ['Ljava/lang/Object;']), [2, 1]);
  clientInterceptB.emit((1 << 8) | 0x0a); // move-result v1
  clientInterceptB.branch21t(0x38, 1, 'ret_null');
  clientInterceptB.invoke35c(0x6e, mIdx('Landroid/net/Uri;', 'getPath', 'Ljava/lang/String;', []), [0]);
  clientInterceptB.emit((0 << 8) | 0x0c); // move-result-object v0 (path)
  clientInterceptB.branch21t(0x38, 0, 'default_path');
  clientInterceptB.emit((1 << 8) | 0x1a, sIdx('/'));
  clientInterceptB.invoke35c(0x6e, mIdx('Ljava/lang/String;', 'equals', 'Z', ['Ljava/lang/Object;']), [0, 1]);
  clientInterceptB.emit((1 << 8) | 0x0a);
  clientInterceptB.branch21t(0x39, 1, 'default_path'); // if-nez
  clientInterceptB.invoke35c(0x6e, mIdx('Ljava/lang/String;', 'length', 'I', []), [0]);
  clientInterceptB.emit((1 << 8) | 0x0a);
  clientInterceptB.branch21t(0x38, 1, 'default_path');
  clientInterceptB.goto16('check_slash');

  clientInterceptB.label('default_path');
  clientInterceptB.emit((0 << 8) | 0x1a, sIdx('index.html'));
  clientInterceptB.goto16('open_asset');

  clientInterceptB.label('check_slash');
  clientInterceptB.emit((1 << 8) | 0x1a, sIdx('/'));
  clientInterceptB.invoke35c(0x6e, mIdx('Ljava/lang/String;', 'startsWith', 'Z', ['Ljava/lang/String;']), [0, 1]);
  clientInterceptB.emit((1 << 8) | 0x0a);
  clientInterceptB.branch21t(0x38, 1, 'open_asset');
  clientInterceptB.emit((1 << 12) | (1 << 8) | 0x12); // const/4 v1, 1
  clientInterceptB.invoke35c(0x6e, mIdx('Ljava/lang/String;', 'substring', 'Ljava/lang/String;', ['I']), [0, 1]);
  clientInterceptB.emit((0 << 8) | 0x0c); // v0 = path without leading '/'

  clientInterceptB.label('open_asset');
  clientInterceptB.emit((1 << 8) | 0x1a, sIdx('www/'));
  clientInterceptB.invoke35c(0x6e, mIdx('Ljava/lang/String;', 'concat', 'Ljava/lang/String;', ['Ljava/lang/String;']), [1, 0]);
  clientInterceptB.emit((1 << 8) | 0x0c); // v1 = "www/" + path
  clientInterceptB.emit((8 << 12) | (2 << 8) | 0x54, fIdx(clientClass, 'assets')); // iget-object v2, v8
  clientInterceptB.invoke35c(0x6e, mIdx('Landroid/content/res/AssetManager;', 'open', 'Ljava/io/InputStream;', ['Ljava/lang/String;']), [2, 1]);
  clientInterceptB.emit((6 << 8) | 0x0c); // move-result-object v6 (InputStream)

  // Determine MIME type in v1 based on extension of path (v0)
  clientInterceptB.emit((1 << 8) | 0x1a, sIdx('application/octet-stream'));
  const extRules: Array<[string, string]> = [
    ['.html', 'text/html'],
    ['.js', 'application/javascript'],
    ['.mjs', 'application/javascript'],
    ['.css', 'text/css'],
    ['.wasm', 'application/wasm'],
    ['.json', 'application/json'],
    ['.webmanifest', 'application/manifest+json'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.ico', 'image/x-icon'],
  ];
  extRules.forEach(([ext, mime], i) => {
    const nextLbl = `ext_next_${i}`;
    clientInterceptB.emit((2 << 8) | 0x1a, sIdx(ext));
    clientInterceptB.invoke35c(0x6e, mIdx('Ljava/lang/String;', 'endsWith', 'Z', ['Ljava/lang/String;']), [0, 2]);
    clientInterceptB.emit((2 << 8) | 0x0a);
    clientInterceptB.branch21t(0x38, 2, nextLbl);
    clientInterceptB.emit((1 << 8) | 0x1a, sIdx(mime));
    clientInterceptB.goto16('mime_done');
    clientInterceptB.label(nextLbl);
  });

  clientInterceptB.label('mime_done');
  // v5 = new HashMap(), add Access-Control-Allow-Origin: *
  clientInterceptB.emit((5 << 8) | 0x22, tIdx('Ljava/util/HashMap;'));
  clientInterceptB.invoke35c(0x70, mIdx('Ljava/util/HashMap;', '<init>', 'V', []), [5]);
  clientInterceptB.emit((2 << 8) | 0x1a, sIdx('Access-Control-Allow-Origin'));
  clientInterceptB.emit((3 << 8) | 0x1a, sIdx('*'));
  clientInterceptB.invoke35c(0x6e, mIdx('Ljava/util/HashMap;', 'put', 'Ljava/lang/Object;', ['Ljava/lang/Object;', 'Ljava/lang/Object;']), [5, 2, 3]);
  // Construct WebResourceResponse(v1=mime, v2="UTF-8", v3=200, v4="OK", v5=headers, v6=stream) into v0
  clientInterceptB.emit((0 << 8) | 0x22, tIdx('Landroid/webkit/WebResourceResponse;'));
  clientInterceptB.emit((2 << 8) | 0x1a, sIdx('UTF-8'));
  clientInterceptB.emit((3 << 8) | 0x13, 200); // const/16 v3, 200
  clientInterceptB.emit((4 << 8) | 0x1a, sIdx('OK'));
  clientInterceptB.invokeRange(
    0x76, // invoke-direct/range
    mIdx('Landroid/webkit/WebResourceResponse;', '<init>', 'V', [
      'Ljava/lang/String;',
      'Ljava/lang/String;',
      'I',
      'Ljava/lang/String;',
      'Ljava/util/Map;',
      'Ljava/io/InputStream;',
    ]),
    0,
    7
  );
  clientInterceptB.emit((0 << 8) | 0x11); // return-object v0

  clientInterceptB.label('ret_null');
  clientInterceptB.emit((0 << 12) | (0 << 8) | 0x12); // const/4 v0, 0
  clientInterceptB.emit((0 << 8) | 0x11); // return-object v0
  const interceptTryEnd = clientInterceptB.pos;

  const interceptCatchAddr = clientInterceptB.pos;
  clientInterceptB.emit((0 << 8) | 0x0d); // move-exception v0
  clientInterceptB.emit((0 << 12) | (0 << 8) | 0x12); // const/4 v0, 0
  clientInterceptB.emit((0 << 8) | 0x11); // return-object v0

  // 8. OfflineChromeClient.<init>(MainActivity)V (regs=2, ins=2, outs=1; v0=this, v1=act)
  const chromeInitB = new InsnBuilder();
  chromeInitB.invoke35c(0x70, mIdx('Landroid/webkit/WebChromeClient;', '<init>', 'V', []), [0]);
  chromeInitB.emit((0 << 12) | (1 << 8) | 0x5b, fIdx(chromeClass, 'activity'));
  chromeInitB.emit(0x000e);

  // 9. OfflineChromeClient.onShowFileChooser(WebView, ValueCallback, FileChooserParams)Z
  //    regs=5, ins=4, outs=3; v1=this, v2=wv, v3=cb, v4=params
  const chromeShowB = new InsnBuilder();
  chromeShowB.emit((1 << 12) | (0 << 8) | 0x54, fIdx(chromeClass, 'activity'));
  chromeShowB.invoke35c(
    0x6e,
    mIdx(mainClass, 'openFileChooser', 'Z', ['Landroid/webkit/ValueCallback;', 'Landroid/webkit/WebChromeClient$FileChooserParams;']),
    [0, 3, 4]
  );
  chromeShowB.emit((0 << 8) | 0x0a); // move-result v0
  chromeShowB.emit((0 << 8) | 0x0f); // return v0

  // Build code items
  const codeItemsBytes = [
    buildCodeItem(1, 1, 1, mainInitB.finalize()),
    buildCodeItem(6, 4, 4, mainActivityResB.finalize()),
    buildCodeItem(2, 1, 1, mainBackB.finalize()),
    buildCodeItem(6, 2, 2, mainOnCreateB.finalize()),
    buildCodeItem(6, 3, 3, mainOpenChooserB.finalize(), {
      startAddr: chooserTryStart,
      endAddr: chooserTryEnd,
      catchAddr: chooserCatchAddr,
    }),
    buildCodeItem(3, 2, 1, clientInitB.finalize()),
    buildCodeItem(11, 3, 7, clientInterceptB.finalize(), {
      startAddr: interceptTryStart,
      endAddr: interceptTryEnd,
      catchAddr: interceptCatchAddr,
    }),
    buildCodeItem(2, 2, 1, chromeInitB.finalize()),
    buildCodeItem(5, 4, 3, chromeShowB.finalize()),
  ];

  // DEX layout computation
  const headerSize = 0x70;
  const stringIdsOff = headerSize;
  const stringIdsSize = sortedStrings.length;
  const typeIdsOff = stringIdsOff + stringIdsSize * 4;
  const typeIdsSize = typeDescriptors.length;
  const protoIdsOff = typeIdsOff + typeIdsSize * 4;
  const protoIdsSize = rawProtos.length;
  const fieldIdsOff = protoIdsOff + protoIdsSize * 12;
  const fieldIdsSize = fields.length;
  const methodIdsOff = fieldIdsOff + fieldIdsSize * 8;
  const methodIdsSize = methods.length;
  const classDefsOff = methodIdsOff + methodIdsSize * 8;

  const classDefsOrder = [
    { cls: mainClass, sup: 'Landroid/app/Activity;' },
    { cls: clientClass, sup: 'Landroid/webkit/WebViewClient;' },
    { cls: chromeClass, sup: 'Landroid/webkit/WebChromeClient;' },
  ];
  const classDefsSize = classDefsOrder.length;

  let dataCursor = classDefsOff + classDefsSize * 32;
  const align4 = () => {
    dataCursor = (dataCursor + 3) & ~3;
  };

  // Code items
  align4();
  const codeSectionOff = dataCursor;
  const codeOffsets: number[] = [];
  for (const ci of codeItemsBytes) {
    align4();
    codeOffsets.push(dataCursor);
    dataCursor += ci.length;
  }

  // Type lists
  const protosWithParams = rawProtos.filter((p) => p.params.length > 0);
  align4();
  const typeListSectionOff = dataCursor;
  const typeListOffsets = new Map<ProtoDef, number>();
  const typeListChunks: Uint8Array[] = [];
  for (const p of protosWithParams) {
    align4();
    typeListOffsets.set(p, dataCursor);
    const tlSize = 4 + p.params.length * 2;
    const tlPadded = (tlSize + 3) & ~3;
    const tl = new Uint8Array(tlPadded);
    const dv = new DataView(tl.buffer);
    dv.setUint32(0, p.params.length, true);
    for (let i = 0; i < p.params.length; i++) {
      dv.setUint16(4 + i * 2, tIdx(p.params[i]), true);
    }
    typeListChunks.push(tl);
    dataCursor += tl.length;
  }

  // String data items
  const stringDataSectionOff = dataCursor;
  const stringDataOffsets: number[] = [];
  const stringDataChunks: Uint8Array[] = [];
  for (const s of sortedStrings) {
    stringDataOffsets.push(dataCursor);
    const enc = encodeMutf8String(s);
    stringDataChunks.push(enc);
    dataCursor += enc.length;
  }

  // Helper to encode class_data_item cleanly (sorted by index with diffs)
  const encodeClassData = (
    instFields: Array<{ idx: number; access: number }>,
    directMethods: Array<{ idx: number; access: number; codeOff: number }>,
    virtualMethods: Array<{ idx: number; access: number; codeOff: number }>
  ): Uint8Array => {
    const out: number[] = [];
    writeUleb128(out, 0); // static_fields_size
    writeUleb128(out, instFields.length);
    writeUleb128(out, directMethods.length);
    writeUleb128(out, virtualMethods.length);

    instFields.sort((a, b) => a.idx - b.idx);
    let prev = 0;
    for (const f of instFields) {
      writeUleb128(out, f.idx - prev);
      writeUleb128(out, f.access);
      prev = f.idx;
    }

    directMethods.sort((a, b) => a.idx - b.idx);
    prev = 0;
    for (const m of directMethods) {
      writeUleb128(out, m.idx - prev);
      writeUleb128(out, m.access);
      writeUleb128(out, m.codeOff);
      prev = m.idx;
    }

    virtualMethods.sort((a, b) => a.idx - b.idx);
    prev = 0;
    for (const m of virtualMethods) {
      writeUleb128(out, m.idx - prev);
      writeUleb128(out, m.access);
      writeUleb128(out, m.codeOff);
      prev = m.idx;
    }

    return new Uint8Array(out);
  };

  const classDataSectionOff = dataCursor;
  const classDataChunks = [
    // MainActivity
    encodeClassData(
      [
        { idx: fIdx(mainClass, 'filePathCallback'), access: 0x0001 },
        { idx: fIdx(mainClass, 'webView'), access: 0x0001 },
      ],
      [{ idx: mIdx(mainClass, '<init>', 'V', []), access: 0x10001, codeOff: codeOffsets[0] }],
      [
        { idx: mIdx(mainClass, 'onActivityResult', 'V', ['I', 'I', 'Landroid/content/Intent;']), access: 0x0004, codeOff: codeOffsets[1] },
        { idx: mIdx(mainClass, 'onBackPressed', 'V', []), access: 0x0001, codeOff: codeOffsets[2] },
        { idx: mIdx(mainClass, 'onCreate', 'V', ['Landroid/os/Bundle;']), access: 0x0004, codeOff: codeOffsets[3] },
        { idx: mIdx(mainClass, 'openFileChooser', 'Z', ['Landroid/webkit/ValueCallback;', 'Landroid/webkit/WebChromeClient$FileChooserParams;']), access: 0x0001, codeOff: codeOffsets[4] },
      ]
    ),
    // OfflineClient
    encodeClassData(
      [{ idx: fIdx(clientClass, 'assets'), access: 0x0012 }],
      [{ idx: mIdx(clientClass, '<init>', 'V', ['Landroid/content/Context;']), access: 0x10001, codeOff: codeOffsets[5] }],
      [{ idx: mIdx(clientClass, 'shouldInterceptRequest', 'Landroid/webkit/WebResourceResponse;', ['Landroid/webkit/WebView;', 'Landroid/webkit/WebResourceRequest;']), access: 0x0001, codeOff: codeOffsets[6] }]
    ),
    // OfflineChromeClient
    encodeClassData(
      [{ idx: fIdx(chromeClass, 'activity'), access: 0x0012 }],
      [{ idx: mIdx(chromeClass, '<init>', 'V', [mainClass]), access: 0x10001, codeOff: codeOffsets[7] }],
      [{ idx: mIdx(chromeClass, 'onShowFileChooser', 'Z', ['Landroid/webkit/WebView;', 'Landroid/webkit/ValueCallback;', 'Landroid/webkit/WebChromeClient$FileChooserParams;']), access: 0x0001, codeOff: codeOffsets[8] }]
    ),
  ];

  const classDataOffsets: number[] = [];
  for (const cd of classDataChunks) {
    classDataOffsets.push(dataCursor);
    dataCursor += cd.length;
  }

  // Map list
  align4();
  const mapListOff = dataCursor;
  const mapItems: Array<[number, number, number]> = [
    [0x0000, 1, 0],
    [0x0001, stringIdsSize, stringIdsOff],
    [0x0002, typeIdsSize, typeIdsOff],
    [0x0003, protoIdsSize, protoIdsOff],
    [0x0004, fieldIdsSize, fieldIdsOff],
    [0x0005, methodIdsSize, methodIdsOff],
    [0x0006, classDefsSize, classDefsOff],
    [0x2001, codeItemsBytes.length, codeSectionOff],
    [0x1001, protosWithParams.length, typeListSectionOff],
    [0x2002, stringIdsSize, stringDataSectionOff],
    [0x2000, classDataChunks.length, classDataSectionOff],
    [0x1000, 1, mapListOff],
  ];

  const mapListBytes = new Uint8Array(4 + mapItems.length * 12);
  {
    const dv = new DataView(mapListBytes.buffer);
    dv.setUint32(0, mapItems.length, true);
    mapItems.forEach(([type, size, off], i) => {
      const base = 4 + i * 12;
      dv.setUint16(base + 0, type, true);
      dv.setUint16(base + 2, 0, true);
      dv.setUint32(base + 4, size, true);
      dv.setUint32(base + 8, off, true);
    });
  }
  dataCursor += mapListBytes.length;

  const totalFileSize = dataCursor;
  const dataOff = codeSectionOff;
  const dataSize = totalFileSize - dataOff;

  const dex = new Uint8Array(totalFileSize);
  const dv = new DataView(dex.buffer);

  dex.set([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00], 0);
  dv.setUint32(0x20, totalFileSize, true);
  dv.setUint32(0x24, headerSize, true);
  dv.setUint32(0x28, 0x12345678, true);
  dv.setUint32(0x2c, 0, true);
  dv.setUint32(0x30, 0, true);
  dv.setUint32(0x34, mapListOff, true);
  dv.setUint32(0x38, stringIdsSize, true);
  dv.setUint32(0x3c, stringIdsOff, true);
  dv.setUint32(0x40, typeIdsSize, true);
  dv.setUint32(0x44, typeIdsOff, true);
  dv.setUint32(0x48, protoIdsSize, true);
  dv.setUint32(0x4c, protoIdsOff, true);
  dv.setUint32(0x50, fieldIdsSize, true);
  dv.setUint32(0x54, fieldIdsOff, true);
  dv.setUint32(0x58, methodIdsSize, true);
  dv.setUint32(0x5c, methodIdsOff, true);
  dv.setUint32(0x60, classDefsSize, true);
  dv.setUint32(0x64, classDefsOff, true);
  dv.setUint32(0x68, dataSize, true);
  dv.setUint32(0x6c, dataOff, true);

  stringDataOffsets.forEach((off, i) => dv.setUint32(stringIdsOff + i * 4, off, true));
  typeDescriptors.forEach((desc, i) => dv.setUint32(typeIdsOff + i * 4, sIdx(desc), true));
  rawProtos.forEach((p, i) => {
    const base = protoIdsOff + i * 12;
    dv.setUint32(base + 0, sIdx(p.shorty), true);
    dv.setUint32(base + 4, tIdx(p.ret), true);
    dv.setUint32(base + 8, p.params.length > 0 ? typeListOffsets.get(p)! : 0, true);
  });
  fields.forEach((f, i) => {
    const base = fieldIdsOff + i * 8;
    dv.setUint16(base + 0, tIdx(f.cls), true);
    dv.setUint16(base + 2, tIdx(f.type), true);
    dv.setUint32(base + 4, sIdx(f.name), true);
  });
  methods.forEach((m, i) => {
    const base = methodIdsOff + i * 8;
    dv.setUint16(base + 0, tIdx(m.cls), true);
    dv.setUint16(base + 2, protoIdx(m.ret, m.params), true);
    dv.setUint32(base + 4, sIdx(m.name), true);
  });
  classDefsOrder.forEach((c, i) => {
    const base = classDefsOff + i * 32;
    dv.setUint32(base + 0, tIdx(c.cls), true);
    dv.setUint32(base + 4, 0x0001, true); // ACC_PUBLIC
    dv.setUint32(base + 8, tIdx(c.sup), true);
    dv.setUint32(base + 12, 0, true);
    dv.setUint32(base + 16, 0xffffffff, true);
    dv.setUint32(base + 20, 0, true);
    dv.setUint32(base + 24, classDataOffsets[i], true);
    dv.setUint32(base + 28, 0, true);
  });

  codeItemsBytes.forEach((ci, i) => dex.set(ci, codeOffsets[i]));
  protosWithParams.forEach((p, i) => dex.set(typeListChunks[i], typeListOffsets.get(p)!));
  stringDataChunks.forEach((c, i) => dex.set(c, stringDataOffsets[i]));
  classDataChunks.forEach((cd, i) => dex.set(cd, classDataOffsets[i]));
  dex.set(mapListBytes, mapListOff);

  const sig = sha1(dex.subarray(32));
  dex.set(sig, 12);
  const cksum = adler32(dex.subarray(12));
  dv.setUint32(8, cksum, true);

  return dex;
}

// ---------- 4. SELF-SIGNED X.509 CERT & PKCS#7 CMS + APK V2 SIGNER ----------
async function createSelfSignedSigner() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );

  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const oidSha256WithRsa = derOid([1, 2, 840, 113549, 1, 1, 11]);
  const oidSha256 = derOid([2, 16, 840, 1, 101, 3, 4, 2, 1]);
  const oidRsaEncryption = derOid([1, 2, 840, 113549, 1, 1, 1]);
  const derNull = new Uint8Array([0x05, 0x00]);
  const algSha256Rsa = derTlv(0x30, oidSha256WithRsa, derNull);
  const algSha256 = derTlv(0x30, oidSha256, derNull);
  const algRsaEnc = derTlv(0x30, oidRsaEncryption, derNull);

  const rdn = (oid: number[], val: string) =>
    derTlv(0x31, derTlv(0x30, derOid(oid), derUtf8Str(val)));
  const subjectName = derTlv(
    0x30,
    rdn([2, 5, 4, 6], 'US'),
    rdn([2, 5, 4, 10], 'Aria48 Audio Studio'),
    rdn([2, 5, 4, 3], 'Aria48 Tracker Offline Android Release')
  );

  const now = new Date();
  const validFrom = derUtcTime(new Date(now.getTime() - 86400_000));
  const validTo = derUtcTime(new Date(now.getTime() + 10 * 365 * 86400_000));
  const serialBytes = new Uint8Array(8);
  crypto.getRandomValues(serialBytes);
  serialBytes[0] &= 0x7f;
  serialBytes[0] |= 0x01;
  const serialDer = derInt(serialBytes);

  const tbsCertificate = derTlv(
    0x30,
    derTlv(0xa0, derInt(2)),
    serialDer,
    algSha256Rsa,
    subjectName,
    derTlv(0x30, validFrom, validTo),
    subjectName,
    spki
  );

  const tbsSig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, tbsCertificate)
  );
  const certDer = derTlv(
    0x30,
    tbsCertificate,
    algSha256Rsa,
    derTlv(0x03, concatBytes(new Uint8Array([0]), tbsSig))
  );

  const signSha256Rsa = async (data: Uint8Array): Promise<Uint8Array> => {
    const copy = new Uint8Array(data.length);
    copy.set(data);
    return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, copy));
  };

  const buildPkcs7CertRsa = async (certSfBytes: Uint8Array): Promise<Uint8Array> => {
    const oidPkcs7Data = derOid([1, 2, 840, 113549, 1, 7, 1]);
    const oidPkcs7SignedData = derOid([1, 2, 840, 113549, 1, 7, 2]);
    const sfSignature = await signSha256Rsa(certSfBytes);

    const issuerAndSerial = derTlv(0x30, subjectName, serialDer);
    const signerInfo = derTlv(
      0x30,
      derInt(1),
      issuerAndSerial,
      algSha256,
      algRsaEnc,
      derTlv(0x04, sfSignature)
    );

    const signedData = derTlv(
      0x30,
      derInt(1),
      derTlv(0x31, algSha256),
      derTlv(0x30, oidPkcs7Data),
      derTlv(0xa0, certDer),
      derTlv(0x31, signerInfo)
    );

    return derTlv(0x30, oidPkcs7SignedData, derTlv(0xa0, signedData));
  };

  return { spki, certDer, signSha256Rsa, buildPkcs7CertRsa };
}

// ---------- 5. ZIP + ZIPALIGN + V1 JAR SIGNING + APK SIGNATURE SCHEME V2 ----------
interface ZipEntry {
  name: string;
  data: Uint8Array;
  compress?: boolean;
}

async function buildAlignedZipSections(entries: ZipEntry[]): Promise<{
  entriesSection: Uint8Array;
  centralDir: Uint8Array;
  eocd: Uint8Array;
}> {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const fnBytes = encoder.encode(entry.name);
    const dataCrc = crc32(entry.data);
    let method = 0; // STORED
    let payload = entry.data;

    if (entry.compress && entry.data.length > 64) {
      const deflated = await deflateRaw(entry.data);
      if (deflated && deflated.length < entry.data.length) {
        method = 8; // DEFLATE
        payload = deflated;
      }
    }

    const headerLen = 30 + fnBytes.length;
    // 4-byte zipalign ONLY applies to STORED (uncompressed) entries in Android APKs
    const alignPad = method === 0 ? (4 - ((offset + headerLen) % 4)) % 4 : 0;

    const lfh = new Uint8Array(headerLen + alignPad + payload.length);
    const ldv = new DataView(lfh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0x0800, true);
    ldv.setUint16(8, method, true);
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, 0x5421, true);
    ldv.setUint32(14, dataCrc, true);
    ldv.setUint32(18, payload.length, true);
    ldv.setUint32(22, entry.data.length, true);
    ldv.setUint16(26, fnBytes.length, true);
    ldv.setUint16(28, alignPad, true);
    lfh.set(fnBytes, 30);
    lfh.set(payload, headerLen + alignPad);
    localParts.push(lfh);

    const cdh = new Uint8Array(46 + fnBytes.length);
    const cdv = new DataView(cdh.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, method, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x5421, true);
    cdv.setUint32(16, dataCrc, true);
    cdv.setUint32(20, payload.length, true);
    cdv.setUint32(24, entry.data.length, true);
    cdv.setUint16(28, fnBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    cdh.set(fnBytes, 46);
    cdParts.push(cdh);

    offset += lfh.length;
  }

  const entriesSection = concatBytes(...localParts);
  const centralDir = concatBytes(...cdParts);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralDir.length, true);
  edv.setUint32(16, entriesSection.length, true);
  edv.setUint16(20, 0, true);

  return { entriesSection, centralDir, eocd };
}

async function computeApkV2ChunkedSha256(
  entriesSection: Uint8Array,
  centralDir: Uint8Array,
  eocdForDigest: Uint8Array
): Promise<Uint8Array> {
  const CHUNK_SIZE = 1024 * 1024;
  const chunkDigests: Uint8Array[] = [];

  for (const section of [entriesSection, centralDir, eocdForDigest]) {
    let off = 0;
    do {
      const end = Math.min(section.length, off + CHUNK_SIZE);
      const slice = section.subarray(off, end);
      const chunkInput = new Uint8Array(5 + slice.length);
      chunkInput[0] = 0xa5;
      new DataView(chunkInput.buffer).setUint32(1, slice.length, true);
      chunkInput.set(slice, 5);
      chunkDigests.push(await sha256(chunkInput));
      off = end;
    } while (off < section.length);
  }

  const topInput = new Uint8Array(5 + chunkDigests.length * 32);
  topInput[0] = 0x5a;
  new DataView(topInput.buffer).setUint32(1, chunkDigests.length, true);
  let pos = 5;
  for (const d of chunkDigests) {
    topInput.set(d, pos);
    pos += 32;
  }
  return sha256(topInput);
}

function lenPrefixedU32(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, true);
  out.set(payload, 4);
  return out;
}

async function buildApkSignatureV2Block(
  entriesSection: Uint8Array,
  centralDir: Uint8Array,
  eocdTemplate: Uint8Array,
  signer: Awaited<ReturnType<typeof createSelfSignedSigner>>
): Promise<{ signingBlock: Uint8Array; updatedEocd: Uint8Array }> {
  const rootDigest = await computeApkV2ChunkedSha256(entriesSection, centralDir, eocdTemplate);

  const SIG_ALGO_RSA_PKCS1_SHA256 = 0x0103;
  const digestEntry = (() => {
    const lp = lenPrefixedU32(rootDigest);
    const b = new Uint8Array(4 + lp.length);
    new DataView(b.buffer).setUint32(0, SIG_ALGO_RSA_PKCS1_SHA256, true);
    b.set(lp, 4);
    return lenPrefixedU32(b);
  })();
  const digestsList = lenPrefixedU32(digestEntry);
  const certsList = lenPrefixedU32(lenPrefixedU32(signer.certDer));
  const additionalAttrs = lenPrefixedU32(new Uint8Array(0));
  const signedDataBytes = concatBytes(digestsList, certsList, additionalAttrs);

  const signatureBytes = await signer.signSha256Rsa(signedDataBytes);
  const sigEntry = (() => {
    const lp = lenPrefixedU32(signatureBytes);
    const b = new Uint8Array(4 + lp.length);
    new DataView(b.buffer).setUint32(0, SIG_ALGO_RSA_PKCS1_SHA256, true);
    b.set(lp, 4);
    return lenPrefixedU32(b);
  })();
  const signaturesList = lenPrefixedU32(sigEntry);
  const pubKeyLp = lenPrefixedU32(signer.spki);

  const signerBlock = lenPrefixedU32(
    concatBytes(lenPrefixedU32(signedDataBytes), signaturesList, pubKeyLp)
  );
  const apkV2BlockValue = lenPrefixedU32(signerBlock);

  const APK_SIG_V2_ID = 0x7109871a;
  const pairLen = 4 + apkV2BlockValue.length;
  const pairBytes = new Uint8Array(8 + pairLen);
  const pdv = new DataView(pairBytes.buffer);
  pdv.setUint32(0, pairLen, true);
  pdv.setUint32(4, 0, true);
  pdv.setUint32(8, APK_SIG_V2_ID, true);
  pairBytes.set(apkV2BlockValue, 12);

  const blockSizeAfterFirstU64 = pairBytes.length + 8 + 16;
  const totalBlockSize = 8 + blockSizeAfterFirstU64;
  const signingBlock = new Uint8Array(totalBlockSize);
  const bdv = new DataView(signingBlock.buffer);
  bdv.setUint32(0, blockSizeAfterFirstU64, true);
  bdv.setUint32(4, 0, true);
  signingBlock.set(pairBytes, 8);
  const tailSizePos = 8 + pairBytes.length;
  bdv.setUint32(tailSizePos, blockSizeAfterFirstU64, true);
  bdv.setUint32(tailSizePos + 4, 0, true);
  signingBlock.set(new TextEncoder().encode('APK Sig Block 42'), tailSizePos + 8);

  const updatedEocd = new Uint8Array(eocdTemplate);
  new DataView(updatedEocd.buffer).setUint32(16, entriesSection.length + signingBlock.length, true);

  return { signingBlock, updatedEocd };
}

export interface OfflineBundleAsset {
  path: string;
  data: Uint8Array;
}

export interface ApkBuildInput {
  offlineFiles: OfflineBundleAsset[];
  iconPngBytes: Uint8Array;
  appName?: string;
  packageName?: string;
  versionName?: string;
  versionCode?: number;
}

export async function buildSignedAria48Apk(input: ApkBuildInput): Promise<{
  apkBytes: Uint8Array;
  fileName: string;
  packageName: string;
  bundledFilesCount: number;
}> {
  if (!input.offlineFiles || input.offlineFiles.length === 0) {
    throw new Error('Offline asset bundle is empty; cannot compile standalone APK');
  }

  const packageName = input.packageName || 'com.aria48.tracker';
  const appName = input.appName || 'Aria48 Tracker';
  const versionName = input.versionName || '2.4.0';
  const versionCode = input.versionCode || 240;

  const iconEntryPath = 'res/mipmap-xxhdpi-v4/ic_launcher.png';
  const manifestXml = buildBinaryAndroidManifest({
    packageName,
    versionCode,
    versionName,
    minSdkVersion: 21,
    targetSdkVersion: 33,
  });
  const resourcesArsc = buildResourcesArsc(packageName, appName, iconEntryPath);
  const classesDex = buildClassesDex(packageName);

  const appConfigJson = new TextEncoder().encode(
    JSON.stringify(
      {
        app: appName,
        package: packageName,
        version: versionName,
        code: versionCode,
        mode: 'offline-standalone',
        origin: 'https://appassets.androidplatform.net/index.html',
        bundledFiles: input.offlineFiles.length,
        builtAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  const fallback1x1Png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
    0x78, 0x9c, 0x63, 0x60, 0x60, 0xf8, 0x0f, 0x00,
    0x01, 0x04, 0x01, 0x00, 0x8d, 0x84, 0x6f, 0x1d,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);
  const hasValidPng =
    input.iconPngBytes &&
    input.iconPngBytes.length >= 24 &&
    input.iconPngBytes[0] === 0x89 &&
    input.iconPngBytes[1] === 0x50 &&
    input.iconPngBytes[2] === 0x4e &&
    input.iconPngBytes[3] === 0x47;
  const resolvedIconBytes = hasValidPng ? input.iconPngBytes : fallback1x1Png;

  const baseEntries: ZipEntry[] = [
    { name: 'AndroidManifest.xml', data: manifestXml, compress: false },
    { name: 'classes.dex', data: classesDex, compress: false },
    { name: 'resources.arsc', data: resourcesArsc, compress: false },
    { name: iconEntryPath, data: resolvedIconBytes, compress: false },
    { name: 'assets/app-config.json', data: appConfigJson, compress: true },
  ];

  for (const file of input.offlineFiles) {
    const clean = file.path.replace(/^\/+/, '');
    // Keep binary wasm uncompressed if small or deflate JS/CSS/HTML cleanly; AssetManager.open() reads both STORED and DEFLATE
    const isBinaryAsset = clean.endsWith('.png') || clean.endsWith('.ico');
    baseEntries.push({
      name: `assets/www/${clean}`,
      data: file.data,
      compress: !isBinaryAsset,
    });
  }

  const manifestLines: string[] = [
    'Manifest-Version: 1.0',
    'Created-By: Aria48 Offline APK Packager',
    '',
  ];
  const sfSectionEntries: string[] = [];

  for (const entry of baseEntries) {
    const d = base64FromBytes(await sha256(entry.data));
    const secText = `Name: ${entry.name}\r\nSHA-256-Digest: ${d}\r\n\r\n`;
    manifestLines.push(`Name: ${entry.name}`, `SHA-256-Digest: ${d}`, '');
    const secDigest = base64FromBytes(await sha256(new TextEncoder().encode(secText)));
    sfSectionEntries.push(`Name: ${entry.name}\r\nSHA-256-Digest: ${secDigest}\r\n\r\n`);
  }

  const manifestMfBytes = new TextEncoder().encode(manifestLines.join('\r\n'));
  const mfFullDigest = base64FromBytes(await sha256(manifestMfBytes));
  const certSfStr =
    `Signature-Version: 1.0\r\nCreated-By: Aria48 Offline APK Packager\r\nSHA-256-Digest-Manifest: ${mfFullDigest}\r\n\r\n` +
    sfSectionEntries.join('');
  const certSfBytes = new TextEncoder().encode(certSfStr);

  const signer = await createSelfSignedSigner();
  const certRsaBytes = await signer.buildPkcs7CertRsa(certSfBytes);

  const allEntries: ZipEntry[] = [
    ...baseEntries,
    { name: 'META-INF/MANIFEST.MF', data: manifestMfBytes, compress: false },
    { name: 'META-INF/CERT.SF', data: certSfBytes, compress: false },
    { name: 'META-INF/CERT.RSA', data: certRsaBytes, compress: false },
  ];

  const { entriesSection, centralDir, eocd } = await buildAlignedZipSections(allEntries);
  const { signingBlock, updatedEocd } = await buildApkSignatureV2Block(
    entriesSection,
    centralDir,
    eocd,
    signer
  );

  const apkBytes = concatBytes(entriesSection, signingBlock, centralDir, updatedEocd);
  return {
    apkBytes,
    fileName: `Aria48Tracker-v${versionName}-offline.apk`,
    packageName,
    bundledFilesCount: input.offlineFiles.length,
  };
}
