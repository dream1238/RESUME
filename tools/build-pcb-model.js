#!/usr/bin/env node
/**
 * build-pcb-model.js —— 51单片机核心板 OBJ → 紧凑二进制(供网站 WebGL 查看器加载)
 *
 * 用法: node tools/build-pcb-model.js [源zip或obj路径] [输出bin路径]
 *
 * 输出格式 v1(全程小端,前端按魔数嗅探是否 gzip):
 *   [0,192)  头 96B + 材质组表 6×16B
 *   [192,192+V*6)  顶点位置 int16 × (x,y,z) 交错
 *   [之后]   varint 差分索引流
 * 体积实测:约 275KB(原 OBJ 4.44MB,gzip 后 985KB)
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SRC = process.argv[2] || 'D:/大学四年/作品集/51单片机核心板/3D_51单片机核心板PCB_2026-10-10.zip';
const OUT = process.argv[3] || path.join(__dirname, '..', 'models', 'pcb-model.js');

/* 材质顺序固定映射(OBJ 中用到的 6 个材质名) */
const MTL_ORDER = ['mtl1', 'mtl2', 'mtl3', 'mtl4', 'mtl5', 'mtl6'];
/**
 * 调色板:不用 MTL 里的原始颜色(渲染出来是"黑底白铜",与实际板子不符),
 * 按物理层含义覆盖为「蓝色阻焊 + 金色引脚 + 暖白焊盘/丝印」,还原板子真实观感。
 * 每项:[R, G, B, spec]
 */
const PALETTE = [
  [0xC9, 0xA4, 0x5C, 200], // mtl1 排针顶面 / 通孔环 —— 金
  [0x2E, 0x2A, 0x24,  60], // mtl2 通孔环另一端 —— 深褐
  [0xED, 0xE6, 0xD2, 150], // mtl3 顶层铜箔 / 焊盘 / 丝印 —— 暖白(镀锡+丝印)
  [0x1B, 0x4F, 0x8F,  35], // mtl4 阻焊层(最大可见面) —— 蓝(板子主色)
  [0x3E, 0x3A, 0x2E,  40], // mtl5 元件侧面 —— 深橄榄
  [0x1A, 0x18, 0x15,  15], // mtl6 基材 / 板边 —— 近黑
];

/* ---------- 1. 读取 OBJ 文本(zip 内存解析,零依赖) ---------- */
function readObjText(src) {
  if (!/\.zip$/i.test(src)) return fs.readFileSync(src).toString('latin1');
  const buf = fs.readFileSync(src);
  /* 从尾部向前找 EOCD(0x06054B50),最多回扫 65557 字节 */
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip EOCD 未找到');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); /* 中央目录起始偏移 */
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014B50) throw new Error('中央目录签名错误');
    const method   = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('latin1');
    if (/\.obj$/i.test(name)) {
      if (buf.readUInt32LE(localOff) !== 0x04034B50) throw new Error('本地头签名错误');
      const lNameLen  = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
      return data.toString('latin1'); /* latin1:注释含中文,避免 UTF-8 多字节切坏行 */
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error('zip 内未找到 .obj 文件');
}

/* ---------- 2. 解析 OBJ ---------- */
console.log('读取源文件:', SRC);
const text = readObjText(SRC);
const lines = text.split(/\r?\n/);
console.log('总行数:', lines.length);

const vx = [], vy = [], vz = [];   /* 原始顶点(解析阶段双精度) */
const tris = [];                    /* 面:[a,b,c,材质索引] 交错 */
let curMtl = -1, vnCount = 0;

for (let li = 0; li < lines.length; li++) {
  const line = lines[li];
  if (!line) continue;
  const c0 = line.charCodeAt(0);
  if (c0 === 118 /* v */) {
    if (line.charCodeAt(1) === 32) {          /* 'v x y z' */
      const t = line.split(/ +/);
      vx.push(parseFloat(t[1])); vy.push(parseFloat(t[2])); vz.push(parseFloat(t[3]));
    } else if (line.startsWith('vn')) {
      vnCount++;                               /* 法线只计数(不存储,运行时不依赖) */
    }
    continue;
  }
  if (c0 === 102 /* f */ && line.charCodeAt(1) === 32) {
    const t = line.split(/ +/);
    const idx = [];
    for (let k = 1; k < t.length; k++) {
      const tok = t[k];
      const slash = tok.indexOf('/');
      const si = slash === -1 ? tok : tok.slice(0, slash);
      let i = parseInt(si, 10);
      i = i < 0 ? vx.length + i : i - 1;       /* OBJ 1-based → 0-based;负数从末尾倒数 */
      idx.push(i);
    }
    for (let k = 1; k + 1 < idx.length; k++) tris.push(idx[0], idx[k], idx[k + 1], curMtl); /* 扇形三角化 */
    continue;
  }
  if (c0 === 117 /* u */ && line.startsWith('usemtl')) {
    const name = line.slice(6).trim();
    const mi = MTL_ORDER.indexOf(name);
    if (mi === -1) throw new Error('未知材质名: [' + name + ']');
    curMtl = mi;
    continue;
  }
}
const V = vx.length;
const T = tris.length / 4;
console.log(`解析完成:顶点 ${V} / 三角面 ${T} / 法线 ${vnCount}(未使用)`);
if (!V || !T) throw new Error('模型为空');

/* ---------- 3. 原始包围盒 → 纯旋转变换 (x, z, -y) 把板子立起来 ---------- */
let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, minz = Infinity, maxz = -Infinity;
for (let i = 0; i < V; i++) {
  const a = vx[i], b = vy[i], c = vz[i];
  if (a < minx) minx = a; if (a > maxx) maxx = a;
  if (b < miny) miny = b; if (b > maxy) maxy = b;
  if (c < minz) minz = c; if (c > maxz) maxz = c;
}
const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
const maxExt = Math.max(maxx - minx, maxy - miny, maxz - minz);
const s = 1 / maxExt; /* 归一化:最长边 = 1 */

/* 变换行列式 = det[x→X, z→Y, -y→Z] = +1(纯旋转,不会镜像绕序) */
const wx = new Float64Array(V), wy = new Float64Array(V), wz = new Float64Array(V);
for (let i = 0; i < V; i++) {
  wx[i] = (vx[i] - cx) * s;
  wy[i] = (vz[i] - cz) * s;
  wz[i] = -(vy[i] - cy) * s;
}

/* 变换后包围盒(量化与相机取景用) */
let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
for (let i = 0; i < V; i++) {
  const a = wx[i], b = wy[i], c = wz[i];
  if (a < bx0) bx0 = a; if (a > bx1) bx1 = a;
  if (b < by0) by0 = b; if (b > by1) by1 = b;
  if (c < bz0) bz0 = c; if (c > bz1) bz1 = c;
}

/* ---------- 4. 按材质重排面(消除 OBJ 中 86 次交错调用 → 6 段连续区间) ---------- */
const byMtl = [[], [], [], [], [], []];
for (let t = 0; t < T; t++) {
  const m = tris[t * 4 + 3];
  if (m < 0) throw new Error(`第 ${t} 个面出现在任何 usemtl 之前`);
  byMtl[m].push(tris[t * 4], tris[t * 4 + 1], tris[t * 4 + 2]);
}
const finalIdx = [];
const groups = [];
let maxIndex = 0;
for (let m = 0; m < 6; m++) {
  const first = finalIdx.length;
  const arr = byMtl[m];
  for (let i = 0; i < arr.length; i++) {
    finalIdx.push(arr[i]);
    if (arr[i] > maxIndex) maxIndex = arr[i];
  }
  groups.push({ first, count: arr.length, color: PALETTE[m] });
  console.log(`  材质 ${m} (${MTL_ORDER[m]}): ${arr.length / 3} 面, 索引区间 [${first}, ${first + arr.length})`);
}
if (maxIndex >= 65536) throw new Error(`最大索引 ${maxIndex} 超出 Uint16 范围`);

/* ---------- 5. 逐轴 Int16 量化(解码: world = q * qScale + qOrigin) ---------- */
const qScaleX = (bx1 - bx0) / 65534, qOriginX = (bx0 + bx1) / 2;
const qScaleY = (by1 - by0) / 65534, qOriginY = (by0 + by1) / 2;
const qScaleZ = (bz1 - bz0) / 65534, qOriginZ = (bz0 + bz1) / 2;
const pos = new Int16Array(V * 3);
let maxErrNorm = 0;
for (let i = 0; i < V; i++) {
  const qx = Math.max(-32767, Math.min(32767, Math.round((wx[i] - qOriginX) / qScaleX)));
  const qy = Math.max(-32767, Math.min(32767, Math.round((wy[i] - qOriginY) / qScaleY)));
  const qz = Math.max(-32767, Math.min(32767, Math.round((wz[i] - qOriginZ) / qScaleZ)));
  maxErrNorm = Math.max(maxErrNorm,
    Math.abs(qx * qScaleX + qOriginX - wx[i]),
    Math.abs(qy * qScaleY + qOriginY - wy[i]),
    Math.abs(qz * qScaleZ + qOriginZ - wz[i]));
  pos[i * 3] = qx; pos[i * 3 + 1] = qy; pos[i * 3 + 2] = qz;
}
const maxErrMM = maxErrNorm * maxExt;
console.log(`量化误差: ${(maxErrMM * 1000).toFixed(4)} µm (阈值 1 µm)`);
if (maxErrMM > 0.001) throw new Error('量化误差超标');

/* ---------- 6. varint + zigzag 差分索引编码 ---------- */
function encodeVarintDiff(idx) {
  const out = [];
  let prev = 0;
  for (let i = 0; i < idx.length; i++) {
    const d = idx[i] - prev;
    prev = idx[i];
    const z = ((d << 1) ^ (d >> 31)) >>> 0; /* zigzag */
    if (z < 0x80) {
      out.push(z);
    } else if (z < 0x4000) {
      out.push(0x80 | (z & 0x7F), (z >>> 7) & 0x7F);
    } else {
      out.push(0x80 | (z & 0x7F), 0x80 | ((z >>> 7) & 0x7F), (z >>> 14) & 0x7F);
    }
  }
  return Buffer.from(out);
}
/* 解码回读自检(与前端解码逻辑同源) */
function decodeVarintDiff(buf, count) {
  const out = new Uint16Array(count);
  let prev = 0, p = 0;
  for (let i = 0; i < count; i++) {
    let b = buf[p++], z = b & 0x7F;
    if (b & 0x80) {
      b = buf[p++]; z |= (b & 0x7F) << 7;
      if (b & 0x80) { b = buf[p++]; z |= (b & 0x7F) << 14; }
    }
    const d = (z >>> 1) ^ -(z & 1);
    prev += d;
    if (prev < 0 || prev >= V) throw new Error(`索引解码越界: ${prev}`);
    out[i] = prev;
  }
  if (p !== buf.length) throw new Error(`varint 流长度不符: 读 ${p} / 总 ${buf.length}`);
  return out;
}
const idxBuf = encodeVarintDiff(finalIdx);
const back = decodeVarintDiff(idxBuf, finalIdx.length);
for (let i = 0; i < finalIdx.length; i++) {
  if (back[i] !== finalIdx[i]) throw new Error(`varint round-trip 不一致 @${i}: ${back[i]} != ${finalIdx[i]}`);
}
let groupSum = 0;
for (const g of groups) groupSum += g.count;
if (groupSum !== T * 3) throw new Error('材质组索引总数不等于 面数×3');
console.log(`索引: ${finalIdx.length} 个 → varint ${idxBuf.length} 字节 (round-trip 自检通过)`);

/* ---------- 7. 拼装文件头 + 体,写 gzip ---------- */
const HEAD = 192;
const header = Buffer.alloc(HEAD);
header.write('PCB1', 0, 'latin1');
header.writeUInt16LE(1, 4);                    /* version */
header.writeUInt16LE(3, 6);                    /* flags: bit0=Int16位置 bit1=varint差分索引 */
header.writeUInt32LE(V, 8);
header.writeUInt32LE(finalIdx.length, 12);
header.writeUInt32LE(T, 16);
header.writeUInt32LE(6, 20);                   /* groupCount */
header.writeUInt32LE(HEAD, 24);                /* posOffset */
header.writeUInt32LE(HEAD + V * 6, 28);        /* idxOffset */
header.writeUInt32LE(96, 32);                  /* groupOffset */
header.writeUInt32LE(idxBuf.length, 36);
header.writeFloatLE(s, 40);                    /* unitScale(原始 mm → 归一化) */
header.writeUInt32LE(0, 44);                   /* reserved */
header.writeFloatLE(qScaleX, 48); header.writeFloatLE(qScaleY, 52); header.writeFloatLE(qScaleZ, 56);
header.writeFloatLE(qOriginX, 60); header.writeFloatLE(qOriginY, 64); header.writeFloatLE(qOriginZ, 68);
header.writeFloatLE(bx0, 72); header.writeFloatLE(by0, 76); header.writeFloatLE(bz0, 80);
header.writeFloatLE(bx1, 84); header.writeFloatLE(by1, 88); header.writeFloatLE(bz1, 92);
let gp = 96;
for (const g of groups) {
  header.writeUInt32LE(g.first, gp);
  header.writeUInt32LE(g.count, gp + 4);
  header[gp + 8] = g.color[0]; header[gp + 9] = g.color[1]; header[gp + 10] = g.color[2];
  header[gp + 11] = g.color[3];
  header.writeUInt32LE(0, gp + 12);
  gp += 16;
}
const full = Buffer.concat([header, Buffer.from(pos.buffer, 0, V * 6), idxBuf]);
const gz = zlib.gzipSync(full, { level: 9 });
/**
 * 输出为 .js(base64 包裹的 gzip 数据)而非纯 .bin:
 * 浏览器的 fetch() 在 file:// 协议下会被 CORS 阻止(用户本地双击打开会加载失败),
 * 而 <script src> 标签不受该限制,file:// 与 http(s) 环境都能正常工作。
 * 前端:script 加载 → atob 解码 → DecompressionStream('gzip') 解压 → 解析。
 */
const js = 'window.__PCB_DATA="' + gz.toString('base64') + '";\n';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, js, 'latin1');

console.log('----------------------------------------');
console.log(`原始二进制 ${(full.length / 1024).toFixed(0)} KB → gzip ${(gz.length / 1024).toFixed(0)} KB → 打包 ${(js.length / 1024).toFixed(0)} KB`);
console.log('已写入:', OUT);
