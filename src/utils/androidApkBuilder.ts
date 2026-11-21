/**
 * androidApkBuilder.ts
 * Spec-compliant Android APK binary compiler & signer (AXML, resources.arsc, Dalvik DEX 035,
 * zipalign + CRC-32 + Central Directory, v1 JAR Signature + APK Signature Scheme v2).
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

function derPrintableStr(s: string): Uint8Array {
  return derTlv(0x13, new TextEncoder().encode(s));
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
  // Resource map attributes MUST occupy string indices 0..resIds.length-1
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
    dv.setUint16(0, 0x0100, true); // RES_XML_START_NAMESPACE_TYPE
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
    dv.setUint16(0, 0x0101, true); // RES_XML_END_NAMESPACE_TYPE
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
    type: number; // 0x01=ref, 0x03=str, 0x10=int, 0x11=hex, 0x12=bool
    value: number | string;
  }

  const startEl = (tag: string, attrs: XmlAttr[]) => {
    const chunkSize = 36 + attrs.length * 20;
    const chunk = new Uint8Array(chunkSize);
    const dv = new DataView(chunk.buffer);
    dv.setUint16(0, 0x0102, true); // RES_XML_START_ELEMENT_TYPE
    dv.setUint16(2, 16, true);
    dv.setUint32(4, chunkSize, true);
    dv.setUint32(8, lineNum++, true);
    dv.setUint32(12, 0xffffffff, true);
    dv.setUint32(16, 0xffffffff, true); // ns
    dv.setUint32(20, intern(tag), true);
    dv.setUint16(24, 20, true); // attributeStart
    dv.setUint16(26, 20, true); // attributeSize
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
      dv.setUint16(off + 12, 8, true); // size of Res_value
      dv.setUint8(off + 14, 0);
      dv.setUint8(off + 15, attr.type);
      dv.setUint32(off + 16, dataVal, true);
    });

    xmlNodes.push(chunk);
  };

  const endEl = (tag: string) => {
    const chunk = new Uint8Array(24);
    const dv = new DataView(chunk.buffer);
    dv.setUint16(0, 0x0103, true); // RES_XML_END_ELEMENT_TYPE
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
    { ns: nsUriIdx, name: 'theme', type: 0x01, value: 0x01030007 }, // @android:style/Theme.NoTitleBar.Fullscreen
    { ns: nsUriIdx, name: 'label', type: 0x01, value: 0x7f010000 }, // @string/app_name
    { ns: nsUriIdx, name: 'icon', type: 0x01, value: 0x7f020000 }, // @mipmap/ic_launcher
    { ns: nsUriIdx, name: 'allowBackup', type: 0x12, value: 0xffffffff },
    { ns: nsUriIdx, name: 'hardwareAccelerated', type: 0x12, value: 0xffffffff },
    { ns: nsUriIdx, name: 'usesCleartextTraffic', type: 0x12, value: 0xffffffff },
  ]);

  startEl('activity', [
    { ns: nsUriIdx, name: 'name', type: 0x03, value: MAIN_ACTIVITY },
    { ns: nsUriIdx, name: 'exported', type: 0x12, value: 0xffffffff },
    { ns: nsUriIdx, name: 'screenOrientation', type: 0x10, value: 6 }, // sensorLandscape
    { ns: nsUriIdx, name: 'configChanges', type: 0x11, value: 0x04a0 }, // orientation|keyboardHidden|screenSize
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
  rdv.setUint16(0, 0x0003, true); // RES_XML_TYPE
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
      dv.setUint16(0, 0x0202, true); // RES_TABLE_TYPE_SPEC_TYPE
      dv.setUint16(2, 16, true);
      dv.setUint32(4, 20, true);
      dv.setUint8(8, typeId);
      dv.setUint32(12, 1, true); // entryCount
      dv.setUint32(16, 0, true); // flags
    }

    // ResTable_type header (84 bytes: 20 fixed + 64 ResTable_config)
    const headerSize = 84;
    const entriesStart = headerSize + 4; // 1 uint32 entry offset
    const entrySize = 16; // ResTable_entry (8) + Res_value (8)
    const typeChunkSize = entriesStart + entrySize;
    const typeChunk = new Uint8Array(typeChunkSize);
    {
      const dv = new DataView(typeChunk.buffer);
      dv.setUint16(0, 0x0201, true); // RES_TABLE_TYPE_TYPE
      dv.setUint16(2, headerSize, true);
      dv.setUint32(4, typeChunkSize, true);
      dv.setUint8(8, typeId);
      dv.setUint32(12, 1, true); // entryCount
      dv.setUint32(16, entriesStart, true);
      dv.setUint32(20, 64, true); // ResTable_config.size = 64

      dv.setUint32(headerSize, 0, true); // offset of entry 0

      // ResTable_entry
      dv.setUint16(entriesStart + 0, 8, true); // size
      dv.setUint16(entriesStart + 2, 0, true); // flags
      dv.setUint32(entriesStart + 4, keyIdx, true);

      // Res_value
      dv.setUint16(entriesStart + 8, 8, true); // size
      dv.setUint8(entriesStart + 10, 0);
      dv.setUint8(entriesStart + 11, 0x03); // TYPE_STRING
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
    dv.setUint16(0, 0x0200, true); // RES_TABLE_PACKAGE_TYPE
    dv.setUint16(2, pkgHeaderSize, true);
    dv.setUint32(4, pkgTotal, true);
    dv.setUint32(8, 0x7f, true); // package id
    for (let i = 0; i < Math.min(127, packageName.length); i++) {
      dv.setUint16(12 + i * 2, packageName.charCodeAt(i), true);
    }
    dv.setUint32(268, typeStringsOff, true);
    dv.setUint32(272, 2, true); // lastPublicType
    dv.setUint32(276, keyStringsOff, true);
    dv.setUint32(280, 2, true); // lastPublicKey
    dv.setUint32(284, 0, true);
  }

  const pkgChunk = concatBytes(pkgHeader, pkgBody);
  const totalSize = 12 + globalPool.length + pkgChunk.length;
  const tableHeader = new Uint8Array(12);
  {
    const dv = new DataView(tableHeader.buffer);
    dv.setUint16(0, 0x0002, true); // RES_TABLE_TYPE
    dv.setUint16(2, 12, true);
    dv.setUint32(4, totalSize, true);
    dv.setUint32(8, 1, true); // packageCount
  }

  return concatBytes(tableHeader, globalPool, pkgChunk);
}

// ---------- 3. VALID DALVIK EXECUTABLE (CLASSES.DEX 035) ----------
export function buildClassesDex(packageName: string, targetUrl: string): Uint8Array {
  const internalClass = `L${packageName.replace(/\./g, '/')}/MainActivity;`;

  const neededStrings = new Set<string>([
    '<init>',
    'L',
    'Landroid/app/Activity;',
    'Landroid/content/Context;',
    'Landroid/os/Bundle;',
    'Landroid/view/View;',
    'Landroid/webkit/WebChromeClient;',
    'Landroid/webkit/WebSettings;',
    'Landroid/webkit/WebView;',
    'Landroid/webkit/WebViewClient;',
    internalClass,
    'Ljava/lang/String;',
    'V',
    'VL',
    'VZ',
    'Z',
    'getSettings',
    'loadUrl',
    'onCreate',
    'setAllowFileAccess',
    'setContentView',
    'setDomStorageEnabled',
    'setJavaScriptEnabled',
    'setMediaPlaybackRequiresUserGesture',
    'setWebChromeClient',
    'setWebViewClient',
    targetUrl,
  ]);

  const sortedStringsFinal = Array.from(neededStrings).sort(compareUtf16CodeUnits);
  const sIdx = (s: string) => {
    const idx = sortedStringsFinal.indexOf(s);
    if (idx < 0) throw new Error(`Missing DEX string: ${s}`);
    return idx;
  };

  const typeDescriptorsFinal = [
    'Landroid/app/Activity;',
    'Landroid/content/Context;',
    'Landroid/os/Bundle;',
    'Landroid/view/View;',
    'Landroid/webkit/WebChromeClient;',
    'Landroid/webkit/WebSettings;',
    'Landroid/webkit/WebView;',
    'Landroid/webkit/WebViewClient;',
    internalClass,
    'Ljava/lang/String;',
    'V',
    'Z',
  ].sort((a, b) => sIdx(a) - sIdx(b));

  const tIdx = (desc: string) => {
    const idx = typeDescriptorsFinal.indexOf(desc);
    if (idx < 0) throw new Error(`Missing DEX type: ${desc}`);
    return idx;
  };

  interface ProtoDef {
    shorty: string;
    ret: string;
    params: string[];
  }

  const rawProtos: ProtoDef[] = [
    { shorty: 'V', ret: 'V', params: [] },
    { shorty: 'L', ret: 'Landroid/webkit/WebSettings;', params: [] },
    { shorty: 'VL', ret: 'V', params: ['Landroid/content/Context;'] },
    { shorty: 'VL', ret: 'V', params: ['Landroid/os/Bundle;'] },
    { shorty: 'VL', ret: 'V', params: ['Landroid/view/View;'] },
    { shorty: 'VL', ret: 'V', params: ['Landroid/webkit/WebChromeClient;'] },
    { shorty: 'VL', ret: 'V', params: ['Landroid/webkit/WebViewClient;'] },
    { shorty: 'VL', ret: 'V', params: ['Ljava/lang/String;'] },
    { shorty: 'VZ', ret: 'V', params: ['Z'] },
  ];

  const compareProtos = (a: ProtoDef, b: ProtoDef) => {
    const rDiff = tIdx(a.ret) - tIdx(b.ret);
    if (rDiff !== 0) return rDiff;
    const minP = Math.min(a.params.length, b.params.length);
    for (let i = 0; i < minP; i++) {
      const pDiff = tIdx(a.params[i]) - tIdx(b.params[i]);
      if (pDiff !== 0) return pDiff;
    }
    return a.params.length - b.params.length;
  };
  rawProtos.sort(compareProtos);

  const protoIdx = (ret: string, params: string[]) =>
    rawProtos.findIndex(
      (p) => p.ret === ret && p.params.length === params.length && p.params.every((x, i) => x === params[i])
    );

  interface MethodDef {
    cls: string;
    name: string;
    ret: string;
    params: string[];
  }

  const methods: MethodDef[] = [
    { cls: 'Landroid/app/Activity;', name: '<init>', ret: 'V', params: [] },
    { cls: 'Landroid/app/Activity;', name: 'onCreate', ret: 'V', params: ['Landroid/os/Bundle;'] },
    { cls: 'Landroid/app/Activity;', name: 'setContentView', ret: 'V', params: ['Landroid/view/View;'] },
    { cls: 'Landroid/webkit/WebChromeClient;', name: '<init>', ret: 'V', params: [] },
    { cls: 'Landroid/webkit/WebSettings;', name: 'setAllowFileAccess', ret: 'V', params: ['Z'] },
    { cls: 'Landroid/webkit/WebSettings;', name: 'setDomStorageEnabled', ret: 'V', params: ['Z'] },
    { cls: 'Landroid/webkit/WebSettings;', name: 'setJavaScriptEnabled', ret: 'V', params: ['Z'] },
    { cls: 'Landroid/webkit/WebSettings;', name: 'setMediaPlaybackRequiresUserGesture', ret: 'V', params: ['Z'] },
    { cls: 'Landroid/webkit/WebView;', name: '<init>', ret: 'V', params: ['Landroid/content/Context;'] },
    { cls: 'Landroid/webkit/WebView;', name: 'getSettings', ret: 'Landroid/webkit/WebSettings;', params: [] },
    { cls: 'Landroid/webkit/WebView;', name: 'loadUrl', ret: 'V', params: ['Ljava/lang/String;'] },
    { cls: 'Landroid/webkit/WebView;', name: 'setWebChromeClient', ret: 'V', params: ['Landroid/webkit/WebChromeClient;'] },
    { cls: 'Landroid/webkit/WebView;', name: 'setWebViewClient', ret: 'V', params: ['Landroid/webkit/WebViewClient;'] },
    { cls: 'Landroid/webkit/WebViewClient;', name: '<init>', ret: 'V', params: [] },
    { cls: internalClass, name: '<init>', ret: 'V', params: [] },
    { cls: internalClass, name: 'onCreate', ret: 'V', params: ['Landroid/os/Bundle;'] },
  ];

  methods.sort((a, b) => {
    const c = tIdx(a.cls) - tIdx(b.cls);
    if (c !== 0) return c;
    const n = sIdx(a.name) - sIdx(b.name);
    if (n !== 0) return n;
    return protoIdx(a.ret, a.params) - protoIdx(b.ret, b.params);
  });

  const mIdx = (cls: string, name: string, ret: string, params: string[]) =>
    methods.findIndex(
      (m) =>
        m.cls === cls &&
        m.name === name &&
        m.ret === ret &&
        m.params.length === params.length &&
        m.params.every((x, i) => x === params[i])
    );

  // Encode Dalvik instructions (16-bit code units)
  const insnsInit: number[] = [
    // invoke-direct {v0}, Activity.<init>()V
    (1 << 12) | 0x70,
    mIdx('Landroid/app/Activity;', '<init>', 'V', []),
    0x0000,
    // return-void
    0x000e,
  ];

  const invoke35c = (opcode: number, method: number, regs: number[]): number[] => {
    const cnt = regs.length;
    const r0 = regs[0] || 0;
    const r1 = regs[1] || 0;
    const r2 = regs[2] || 0;
    const r3 = regs[3] || 0;
    const r4 = regs[4] || 0;
    return [((cnt & 0xf) << 12) | ((r4 & 0xf) << 8) | opcode, method, ((r3 & 0xf) << 12) | ((r2 & 0xf) << 8) | ((r1 & 0xf) << 4) | (r0 & 0xf)];
  };

  // onCreate(Bundle): registers=5 (locals v0,v1,v2; params v3=this, v4=savedInstanceState), ins=2, outs=2
  const insnsOnCreate: number[] = [
    // invoke-super {v3, v4}, Activity.onCreate(Bundle)V
    ...invoke35c(0x6f, mIdx('Landroid/app/Activity;', 'onCreate', 'V', ['Landroid/os/Bundle;']), [3, 4]),
    // new-instance v0, WebView
    (0 << 8) | 0x22,
    tIdx('Landroid/webkit/WebView;'),
    // invoke-direct {v0, v3}, WebView.<init>(Context)V
    ...invoke35c(0x70, mIdx('Landroid/webkit/WebView;', '<init>', 'V', ['Landroid/content/Context;']), [0, 3]),
    // invoke-virtual {v0}, WebView.getSettings()WebSettings
    ...invoke35c(0x6e, mIdx('Landroid/webkit/WebView;', 'getSettings', 'Landroid/webkit/WebSettings;', []), [0]),
    // move-result-object v1
    (1 << 8) | 0x0c,
    // const/4 v2, 1
    ((1 & 0xf) << 12) | (2 << 8) | 0x12,
    // invoke-virtual {v1, v2}, WebSettings.setJavaScriptEnabled(Z)V
    ...invoke35c(0x6e, mIdx('Landroid/webkit/WebSettings;', 'setJavaScriptEnabled', 'V', ['Z']), [1, 2]),
    // invoke-virtual {v1, v2}, WebSettings.setDomStorageEnabled(Z)V
    ...invoke35c(0x6e, mIdx('Landroid/webkit/WebSettings;', 'setDomStorageEnabled', 'V', ['Z']), [1, 2]),
    // invoke-virtual {v1, v2}, WebSettings.setAllowFileAccess(Z)V
    ...invoke35c(0x6e, mIdx('Landroid/webkit/WebSettings;', 'setAllowFileAccess', 'V', ['Z']), [1, 2]),
    // const/4 v2, 0
    (2 << 8) | 0x12,
    // invoke-virtual {v1, v2}, WebSettings.setMediaPlaybackRequiresUserGesture(Z)V
    ...invoke35c(0x6e, mIdx('Landroid/webkit/WebSettings;', 'setMediaPlaybackRequiresUserGesture', 'V', ['Z']), [1, 2]),
    // new-instance v2, WebViewClient
    (2 << 8) | 0x22,
    tIdx('Landroid/webkit/WebViewClient;'),
    // invoke-direct {v2}, WebViewClient.<init>()V
    ...invoke35c(0x70, mIdx('Landroid/webkit/WebViewClient;', '<init>', 'V', []), [2]),
    // invoke-virtual {v0, v2}, WebView.setWebViewClient(WebViewClient)V
    ...invoke35c(0x6e, mIdx('Landroid/webkit/WebView;', 'setWebViewClient', 'V', ['Landroid/webkit/WebViewClient;']), [0, 2]),
    // new-instance v2, WebChromeClient
    (2 << 8) | 0x22,
    tIdx('Landroid/webkit/WebChromeClient;'),
    // invoke-direct {v2}, WebChromeClient.<init>()V
    ...invoke35c(0x70, mIdx('Landroid/webkit/WebChromeClient;', '<init>', 'V', []), [2]),
    // invoke-virtual {v0, v2}, WebView.setWebChromeClient(WebChromeClient)V
    ...invoke35c(0x6e, mIdx('Landroid/webkit/WebView;', 'setWebChromeClient', 'V', ['Landroid/webkit/WebChromeClient;']), [0, 2]),
    // invoke-virtual {v3, v0}, Activity.setContentView(View)V
    ...invoke35c(0x6e, mIdx('Landroid/app/Activity;', 'setContentView', 'V', ['Landroid/view/View;']), [3, 0]),
    // const-string v2, targetUrl
    (2 << 8) | 0x1a,
    sIdx(targetUrl),
    // invoke-virtual {v0, v2}, WebView.loadUrl(String)V
    ...invoke35c(0x6e, mIdx('Landroid/webkit/WebView;', 'loadUrl', 'V', ['Ljava/lang/String;']), [0, 2]),
    // return-void
    0x000e,
  ];

  const buildCodeItem = (regs: number, ins: number, outs: number, insns: number[]): Uint8Array => {
    const rawSize = 16 + insns.length * 2;
    const padded = (rawSize + 3) & ~3;
    const buf = new Uint8Array(padded);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, regs, true);
    dv.setUint16(2, ins, true);
    dv.setUint16(4, outs, true);
    dv.setUint16(6, 0, true); // tries_size
    dv.setUint32(8, 0, true); // debug_info_off
    dv.setUint32(12, insns.length, true);
    for (let i = 0; i < insns.length; i++) {
      dv.setUint16(16 + i * 2, insns[i] & 0xffff, true);
    }
    return buf;
  };

  // Compute exact DEX section layout
  const headerSize = 0x70;
  const stringIdsOff = headerSize;
  const stringIdsSize = sortedStringsFinal.length;
  const typeIdsOff = stringIdsOff + stringIdsSize * 4;
  const typeIdsSize = typeDescriptorsFinal.length;
  const protoIdsOff = typeIdsOff + typeIdsSize * 4;
  const protoIdsSize = rawProtos.length;
  const methodIdsOff = protoIdsOff + protoIdsSize * 12;
  const methodIdsSize = methods.length;
  const classDefsOff = methodIdsOff + methodIdsSize * 8;
  const classDefsSize = 1;

  let dataCursor = classDefsOff + classDefsSize * 32;
  const align4 = () => {
    dataCursor = (dataCursor + 3) & ~3;
  };

  // Code items (4-byte aligned)
  align4();
  const codeSectionOff = dataCursor;
  const codeInitOff = dataCursor;
  const codeInitBytes = buildCodeItem(1, 1, 1, insnsInit);
  dataCursor += codeInitBytes.length;

  align4();
  const codeOnCreateOff = dataCursor;
  const codeOnCreateBytes = buildCodeItem(5, 2, 2, insnsOnCreate);
  dataCursor += codeOnCreateBytes.length;

  // Type lists (4-byte aligned, for protos with params.length > 0)
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

  // String data items (1-byte aligned inside data section)
  const stringDataSectionOff = dataCursor;
  const stringDataOffsets: number[] = [];
  const stringDataChunks: Uint8Array[] = [];
  for (const s of sortedStringsFinal) {
    stringDataOffsets.push(dataCursor);
    const enc = encodeMutf8String(s);
    stringDataChunks.push(enc);
    dataCursor += enc.length;
  }

  // Class data item (MainActivity)
  const classDataOff = dataCursor;
  const classDataBytesList: number[] = [];
  writeUleb128(classDataBytesList, 0); // static_fields_size
  writeUleb128(classDataBytesList, 0); // instance_fields_size
  writeUleb128(classDataBytesList, 1); // direct_methods_size
  writeUleb128(classDataBytesList, 1); // virtual_methods_size
  // Direct method: <init>
  writeUleb128(classDataBytesList, mIdx(internalClass, '<init>', 'V', []));
  writeUleb128(classDataBytesList, 0x10001); // ACC_PUBLIC | ACC_CONSTRUCTOR
  writeUleb128(classDataBytesList, codeInitOff);
  // Virtual method: onCreate
  writeUleb128(classDataBytesList, mIdx(internalClass, 'onCreate', 'V', ['Landroid/os/Bundle;']));
  writeUleb128(classDataBytesList, 0x0004); // ACC_PROTECTED
  writeUleb128(classDataBytesList, codeOnCreateOff);
  const classDataBytes = new Uint8Array(classDataBytesList);
  dataCursor += classDataBytes.length;

  // Map list (4-byte aligned)
  align4();
  const mapListOff = dataCursor;
  const mapItems: Array<[number, number, number]> = [
    [0x0000, 1, 0], // TYPE_HEADER_ITEM
    [0x0001, stringIdsSize, stringIdsOff], // TYPE_STRING_ID_ITEM
    [0x0002, typeIdsSize, typeIdsOff], // TYPE_TYPE_ID_ITEM
    [0x0003, protoIdsSize, protoIdsOff], // TYPE_PROTO_ID_ITEM
    [0x0005, methodIdsSize, methodIdsOff], // TYPE_METHOD_ID_ITEM
    [0x0006, classDefsSize, classDefsOff], // TYPE_CLASS_DEF_ITEM
    [0x2001, 2, codeSectionOff], // TYPE_CODE_ITEM
    [0x1001, protosWithParams.length, typeListSectionOff], // TYPE_TYPE_LIST
    [0x2002, stringIdsSize, stringDataSectionOff], // TYPE_STRING_DATA_ITEM
    [0x2000, 1, classDataOff], // TYPE_CLASS_DATA_ITEM
    [0x1000, 1, mapListOff], // TYPE_MAP_LIST
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

  // Header (0x70 bytes)
  const magic = [0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00]; // "dex\n035\0"
  dex.set(magic, 0);
  dv.setUint32(0x20, totalFileSize, true);
  dv.setUint32(0x24, headerSize, true);
  dv.setUint32(0x28, 0x12345678, true); // ENDIAN_CONSTANT
  dv.setUint32(0x2c, 0, true); // link_size
  dv.setUint32(0x30, 0, true); // link_off
  dv.setUint32(0x34, mapListOff, true);
  dv.setUint32(0x38, stringIdsSize, true);
  dv.setUint32(0x3c, stringIdsOff, true);
  dv.setUint32(0x40, typeIdsSize, true);
  dv.setUint32(0x44, typeIdsOff, true);
  dv.setUint32(0x48, protoIdsSize, true);
  dv.setUint32(0x4c, protoIdsOff, true);
  dv.setUint32(0x50, 0, true); // field_ids_size
  dv.setUint32(0x54, 0, true); // field_ids_off
  dv.setUint32(0x58, methodIdsSize, true);
  dv.setUint32(0x5c, methodIdsOff, true);
  dv.setUint32(0x60, classDefsSize, true);
  dv.setUint32(0x64, classDefsOff, true);
  dv.setUint32(0x68, dataSize, true);
  dv.setUint32(0x6c, dataOff, true);

  // Write string_ids, type_ids, proto_ids, method_ids, class_defs
  stringDataOffsets.forEach((off, i) => dv.setUint32(stringIdsOff + i * 4, off, true));
  typeDescriptorsFinal.forEach((desc, i) => dv.setUint32(typeIdsOff + i * 4, sIdx(desc), true));
  rawProtos.forEach((p, i) => {
    const base = protoIdsOff + i * 12;
    dv.setUint32(base + 0, sIdx(p.shorty), true);
    dv.setUint32(base + 4, tIdx(p.ret), true);
    dv.setUint32(base + 8, p.params.length > 0 ? typeListOffsets.get(p)! : 0, true);
  });
  methods.forEach((m, i) => {
    const base = methodIdsOff + i * 8;
    dv.setUint16(base + 0, tIdx(m.cls), true);
    dv.setUint16(base + 2, protoIdx(m.ret, m.params), true);
    dv.setUint32(base + 4, sIdx(m.name), true);
  });
  {
    const base = classDefsOff;
    dv.setUint32(base + 0, tIdx(internalClass), true);
    dv.setUint32(base + 4, 0x0001, true); // ACC_PUBLIC
    dv.setUint32(base + 8, tIdx('Landroid/app/Activity;'), true);
    dv.setUint32(base + 12, 0, true); // interfaces_off
    dv.setUint32(base + 16, 0xffffffff, true); // NO_INDEX source file
    dv.setUint32(base + 20, 0, true); // annotations_off
    dv.setUint32(base + 24, classDataOff, true);
    dv.setUint32(base + 28, 0, true); // static_values_off
  }

  // Write data items
  dex.set(codeInitBytes, codeInitOff);
  dex.set(codeOnCreateBytes, codeOnCreateOff);
  protosWithParams.forEach((p, i) => dex.set(typeListChunks[i], typeListOffsets.get(p)!));
  stringDataChunks.forEach((c, i) => dex.set(c, stringDataOffsets[i]));
  dex.set(classDataBytes, classDataOff);
  dex.set(mapListBytes, mapListOff);

  // Compute SHA-1 signature (bytes 32..end) and Adler-32 checksum (bytes 12..end)
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
    rdn([2, 5, 4, 3], 'Aria48 Tracker Android Release')
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
    derTlv(0xa0, derInt(2)), // v3
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
      derInt(1), // version 1
      issuerAndSerial,
      algSha256,
      algRsaEnc,
      derTlv(0x04, sfSignature)
    );

    const signedData = derTlv(
      0x30,
      derInt(1), // CMS version 1
      derTlv(0x31, algSha256), // digestAlgorithms SET
      derTlv(0x30, oidPkcs7Data), // encapContentInfo (detached)
      derTlv(0xa0, certDer), // certificates [0] IMPLICIT
      derTlv(0x31, signerInfo) // signerInfos SET
    );

    return derTlv(0x30, oidPkcs7SignedData, derTlv(0xa0, signedData));
  };

  return { spki, certDer, signSha256Rsa, buildPkcs7CertRsa };
}

// ---------- 5. ZIP + ZIPALIGN + V1 JAR SIGNING + APK SIGNATURE SCHEME V2 ----------
interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function buildAlignedZipSections(entries: ZipEntry[]): {
  entriesSection: Uint8Array;
  centralDir: Uint8Array;
  eocd: Uint8Array;
} {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const fnBytes = encoder.encode(entry.name);
    const dataCrc = crc32(entry.data);
    // 4-byte zipalign for stored entries
    const headerLen = 30 + fnBytes.length;
    const alignPad = (4 - ((offset + headerLen) % 4)) % 4;

    const lfh = new Uint8Array(headerLen + alignPad + entry.data.length);
    const ldv = new DataView(lfh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    ldv.setUint16(8, 0, true); // STORED
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, 0x5421, true);
    ldv.setUint32(14, dataCrc, true);
    ldv.setUint32(18, entry.data.length, true);
    ldv.setUint32(22, entry.data.length, true);
    ldv.setUint16(26, fnBytes.length, true);
    ldv.setUint16(28, alignPad, true);
    lfh.set(fnBytes, 30);
    // extra field bytes (alignPad zero bytes) left as 0
    lfh.set(entry.data, headerLen + alignPad);
    localParts.push(lfh);

    const cdh = new Uint8Array(46 + fnBytes.length);
    const cdv = new DataView(cdh.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0x0800, true); // UTF-8
    cdv.setUint16(10, 0, true); // STORED
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x5421, true);
    cdv.setUint32(16, dataCrc, true);
    cdv.setUint32(20, entry.data.length, true);
    cdv.setUint32(24, entry.data.length, true);
    cdv.setUint16(28, fnBytes.length, true);
    cdv.setUint16(30, 0, true); // extra field length
    cdv.setUint16(32, 0, true); // comment length
    cdv.setUint16(34, 0, true); // disk number
    cdv.setUint16(36, 0, true); // internal attrs
    cdv.setUint32(38, 0, true); // external attrs
    cdv.setUint32(42, offset, true); // relative offset of local header
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
  // For APK v2 digest computation, EOCD's central directory offset is treated as entriesSection.length
  const rootDigest = await computeApkV2ChunkedSha256(entriesSection, centralDir, eocdTemplate);

  const SIG_ALGO_RSA_PKCS1_SHA256 = 0x0103;
  // digest entry: u32 sig_algo + len_prefixed(digest)
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

  // ID-value pair: u64 pairSize + u32 ID (0x7109871a) + value
  const APK_SIG_V2_ID = 0x7109871a;
  const pairLen = 4 + apkV2BlockValue.length;
  const pairBytes = new Uint8Array(8 + pairLen);
  const pdv = new DataView(pairBytes.buffer);
  pdv.setUint32(0, pairLen, true);
  pdv.setUint32(4, 0, true);
  pdv.setUint32(8, APK_SIG_V2_ID, true);
  pairBytes.set(apkV2BlockValue, 12);

  // Align total signing block size to 4096-byte page boundary (optional padding block 0x42726577) or clean 8-byte block
  const blockSizeAfterFirstU64 = pairBytes.length + 8 + 16; // pairs + size_u64 + "APK Sig Block 42"
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

export interface ApkBuildInput {
  targetUrl: string;
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
  targetUrl: string;
}> {
  const packageName = input.packageName || 'com.aria48.tracker';
  const appName = input.appName || 'Aria48 Tracker';
  const versionName = input.versionName || '2.4.0';
  const versionCode = input.versionCode || 240;
  const safeUrl =
    input.targetUrl && /^https?:\/\//i.test(input.targetUrl)
      ? input.targetUrl
      : 'https://aria48-tracker.web.app/';

  const iconEntryPath = 'res/mipmap-xxhdpi-v4/ic_launcher.png';
  const manifestXml = buildBinaryAndroidManifest({
    packageName,
    versionCode,
    versionName,
    minSdkVersion: 21,
    targetSdkVersion: 33,
  });
  const resourcesArsc = buildResourcesArsc(packageName, appName, iconEntryPath);
  const classesDex = buildClassesDex(packageName, safeUrl);
  const appConfigJson = new TextEncoder().encode(
    JSON.stringify(
      {
        app: appName,
        package: packageName,
        version: versionName,
        code: versionCode,
        url: safeUrl,
        builtAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  const baseEntries: ZipEntry[] = [
    { name: 'AndroidManifest.xml', data: manifestXml },
    { name: 'classes.dex', data: classesDex },
    { name: 'resources.arsc', data: resourcesArsc },
    { name: iconEntryPath, data: input.iconPngBytes },
    { name: 'assets/app-config.json', data: appConfigJson },
  ];

  // Build v1 JAR signature (META-INF/MANIFEST.MF, META-INF/CERT.SF, META-INF/CERT.RSA)
  const manifestLines: string[] = [
    'Manifest-Version: 1.0',
    'Created-By: Aria48 APK Packager',
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
    `Signature-Version: 1.0\r\nCreated-By: Aria48 APK Packager\r\nSHA-256-Digest-Manifest: ${mfFullDigest}\r\n\r\n` +
    sfSectionEntries.join('');
  const certSfBytes = new TextEncoder().encode(certSfStr);

  const signer = await createSelfSignedSigner();
  const certRsaBytes = await signer.buildPkcs7CertRsa(certSfBytes);

  const allEntries: ZipEntry[] = [
    ...baseEntries,
    { name: 'META-INF/MANIFEST.MF', data: manifestMfBytes },
    { name: 'META-INF/CERT.SF', data: certSfBytes },
    { name: 'META-INF/CERT.RSA', data: certRsaBytes },
  ];

  const { entriesSection, centralDir, eocd } = buildAlignedZipSections(allEntries);
  const { signingBlock, updatedEocd } = await buildApkSignatureV2Block(
    entriesSection,
    centralDir,
    eocd,
    signer
  );

  const apkBytes = concatBytes(entriesSection, signingBlock, centralDir, updatedEocd);
  return {
    apkBytes,
    fileName: `Aria48Tracker-v${versionName}.apk`,
    packageName,
    targetUrl: safeUrl,
  };
}
