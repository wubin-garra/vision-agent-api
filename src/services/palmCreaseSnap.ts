import sharp from "sharp";

import type { PalmLineId, PalmPathMap, PalmPoint } from "./palmGeometry.js";

type CreaseMap = {
  /** 沟壑响应：越大表示相对邻域越暗（越像掌纹沟） */
  data: Float32Array;
  width: number;
  height: number;
};

const LINE_SNAP: Record<
  PalmLineId,
  { radius: number; minGain: number; passes: number }
> = {
  // 主横纹/生命线沟通常更深；半径按 512 边长像素
  heart: { radius: 20, minGain: 1.8, passes: 2 },
  head: { radius: 20, minGain: 1.8, passes: 2 },
  life: { radius: 22, minGain: 1.5, passes: 2 },
  // 事业线常较浅，缩小搜索、提高门槛，避免吸到错误细纹
  career: { radius: 12, minGain: 3.2, passes: 2 },
};

function boxBlur(
  src: Float32Array,
  w: number,
  h: number,
  radius: number,
): Float32Array {
  if (radius <= 0) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const span = radius * 2 + 1;

  // horizontal
  for (let y = 0; y < h; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      const xx = Math.min(w - 1, Math.max(0, x));
      sum += src[y * w + xx]!;
    }
    for (let x = 0; x < w; x += 1) {
      tmp[y * w + x] = sum / span;
      const leave = Math.min(w - 1, Math.max(0, x - radius));
      const enter = Math.min(w - 1, Math.max(0, x + radius + 1));
      sum += src[y * w + enter]! - src[y * w + leave]!;
    }
  }

  // vertical
  for (let x = 0; x < w; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      const yy = Math.min(h - 1, Math.max(0, y));
      sum += tmp[yy * w + x]!;
    }
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = sum / span;
      const leave = Math.min(h - 1, Math.max(0, y - radius));
      const enter = Math.min(h - 1, Math.max(0, y + radius + 1));
      sum += tmp[enter * w + x]! - tmp[leave * w + x]!;
    }
  }
  return out;
}

function sample(map: CreaseMap, x: number, y: number): number {
  const { width: w, height: h, data } = map;
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return -1e9;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = data[y0 * w + x0]!;
  const i10 = data[y0 * w + x0 + 1]!;
  const i01 = data[(y0 + 1) * w + x0]!;
  const i11 = data[(y0 + 1) * w + x0 + 1]!;
  return (
    i00 * (1 - fx) * (1 - fy) +
    i10 * fx * (1 - fy) +
    i01 * (1 - fx) * fy +
    i11 * fx * fy
  );
}

/** 灰度 + 局部均值差，突出掌纹沟壑 */
export async function buildCreaseMap(imageBytes: Buffer): Promise<CreaseMap> {
  const maxSide = 512;
  const { data, info } = await sharp(imageBytes)
    .rotate()
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .greyscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = data[i]!;
  }

  const blur = boxBlur(gray, w, h, 3);
  const valley = new Float32Array(w * h);
  for (let i = 0; i < valley.length; i += 1) {
    // 比邻域更暗 → 正响应（沟）
    valley[i] = blur[i]! - gray[i]!;
  }

  return { data: valley, width: w, height: h };
}

function pctToPx(p: PalmPoint, w: number, h: number): { x: number; y: number } {
  return { x: (p.x / 100) * w, y: (p.y / 100) * h };
}

function pxToPct(p: { x: number; y: number }, w: number, h: number): PalmPoint {
  return {
    x: Math.round(Math.min(100, Math.max(0, (p.x / w) * 100)) * 10) / 10,
    y: Math.round(Math.min(100, Math.max(0, (p.y / h) * 100)) * 10) / 10,
  };
}

function densify(path: PalmPoint[], targetCount: number): PalmPoint[] {
  if (path.length < 2 || targetCount <= path.length) return path;
  const pts = path.map((p) => ({ x: p.x, y: p.y }));
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const len = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
    seg.push(len);
    total += len;
  }
  if (total < 1e-6) return path;

  const out: PalmPoint[] = [];
  for (let i = 0; i < targetCount; i += 1) {
    const target = (i / (targetCount - 1)) * total;
    let acc = 0;
    for (let s = 0; s < seg.length; s += 1) {
      const next = acc + seg[s]!;
      if (target <= next || s === seg.length - 1) {
        const t = seg[s]! < 1e-6 ? 0 : (target - acc) / seg[s]!;
        const a = pts[s]!;
        const b = pts[s + 1]!;
        out.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
        });
        break;
      }
      acc = next;
    }
  }
  return out;
}

function smoothPath(path: PalmPoint[]): PalmPoint[] {
  if (path.length < 3) return path;
  const out: PalmPoint[] = [path[0]!];
  for (let i = 1; i < path.length - 1; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const c = path[i + 1]!;
    out.push({
      x: Math.round((a.x * 0.25 + b.x * 0.5 + c.x * 0.25) * 10) / 10,
      y: Math.round((a.y * 0.25 + b.y * 0.5 + c.y * 0.25) * 10) / 10,
    });
  }
  out.push(path[path.length - 1]!);
  return out;
}

function snapOnePath(
  path: PalmPoint[],
  map: CreaseMap,
  lineId: PalmLineId,
): PalmPoint[] {
  if (path.length < 2) return path;
  const cfg = LINE_SNAP[lineId];
  let pts = densify(path, 14).map((p) => pctToPx(p, map.width, map.height));

  for (let pass = 0; pass < cfg.passes; pass += 1) {
    const next: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < pts.length; i += 1) {
      const prev = pts[Math.max(0, i - 1)]!;
      const cur = pts[i]!;
      const nxt = pts[Math.min(pts.length - 1, i + 1)]!;
      let tx = nxt.x - prev.x;
      let ty = nxt.y - prev.y;
      const tlen = Math.hypot(tx, ty) || 1;
      tx /= tlen;
      ty /= tlen;
      const nx = -ty;
      const ny = tx;

      const centerScore = sample(map, cur.x, cur.y);
      let bestD = 0;
      let bestScore = centerScore;

      for (let d = -cfg.radius; d <= cfg.radius; d += 1) {
        if (d === 0) continue;
        const sc = sample(map, cur.x + nx * d, cur.y + ny * d);
        if (sc > bestScore) {
          bestScore = sc;
          bestD = d;
        }
      }

      // 端点少动，避免甩出掌缘；中间点要求增益够才吸附
      const isEnd = i === 0 || i === pts.length - 1;
      const gain = bestScore - centerScore;
      const allow =
        !isEnd && bestD !== 0 && gain >= cfg.minGain
          ? bestD
          : isEnd && gain >= cfg.minGain * 1.5
            ? Math.round(bestD * 0.4)
            : 0;

      next.push({
        x: cur.x + nx * allow,
        y: cur.y + ny * allow,
      });
    }
    pts = next;
  }

  const pct = pts.map((p) => pxToPct(p, map.width, map.height));
  return smoothPath(smoothPath(pct));
}

/** 把解剖示意线沿法线吸附到图像中的真实暗沟 */
export async function snapPathsToCreases(
  imageBytes: Buffer,
  paths: PalmPathMap,
): Promise<PalmPathMap> {
  const map = await buildCreaseMap(imageBytes);
  return {
    heart: snapOnePath(paths.heart, map, "heart"),
    head: snapOnePath(paths.head, map, "head"),
    life: snapOnePath(paths.life, map, "life"),
    career: snapOnePath(paths.career, map, "career"),
  };
}
