import sharp from "sharp";

import type {
  PalmFrame,
  PalmLineId,
  PalmPathMap,
  PalmPoint,
} from "./palmGeometry.js";

type CreaseMap = {
  /** 沟壑响应：越大表示相对邻域越暗（越像掌纹沟） */
  data: Float32Array;
  width: number;
  height: number;
};

type Vec = { x: number; y: number };

/** 每条线在掌高轴上的搜索带（指根=0 → 腕=1） */
const LINE_ROI: Record<
  PalmLineId,
  {
    depthMin: number;
    depthMax: number;
    /** 横向：相对 pinky→index 的跨度容差（相对 palmW） */
    lateralPad: number;
    preferDir: "across" | "down" | "life";
  }
> = {
  // 感情线：掌心上方 20%～40%
  heart: { depthMin: 0.18, depthMax: 0.42, lateralPad: 0.12, preferDir: "across" },
  // 智慧线：35%～60%
  head: { depthMin: 0.33, depthMax: 0.62, lateralPad: 0.14, preferDir: "across" },
  // 生命线：虎口到腕，沿拇指侧
  life: { depthMin: 0.22, depthMax: 0.98, lateralPad: 0.35, preferDir: "life" },
  // 事业线：腕中 → 中指，细长纵向带
  career: { depthMin: 0.35, depthMax: 0.98, lateralPad: 0.1, preferDir: "down" },
};

const LINE_SNAP: Record<
  PalmLineId,
  { radius: number; minGain: number; passes: number }
> = {
  heart: { radius: 14, minGain: 2.0, passes: 2 },
  head: { radius: 14, minGain: 2.0, passes: 2 },
  life: { radius: 16, minGain: 1.6, passes: 2 },
  // 事业线：更严，避免吸到错误细纹
  career: { radius: 8, minGain: 3.5, passes: 2 },
};

/** 事业线纵向纹理门控：ROI 内平均 valley 低于此值则不画 */
const CAREER_TEXTURE_MIN = 2.4;
const CAREER_TEXTURE_SAMPLES = 48;

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
    valley[i] = blur[i]! - gray[i]!;
  }

  return { data: valley, width: w, height: h };
}

function pctToPx(p: PalmPoint, w: number, h: number): Vec {
  return { x: (p.x / 100) * w, y: (p.y / 100) * h };
}

function pxToPct(p: Vec, w: number, h: number): PalmPoint {
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

function strongSmooth(path: PalmPoint[]): PalmPoint[] {
  let p = path;
  for (let i = 0; i < 3; i += 1) p = smoothPath(p);
  return p;
}

/** 图像像素 → 归一化掌坐标（与 frame 同空间） */
function pxToNorm(px: Vec, mapW: number, mapH: number): Vec {
  return { x: px.x / mapW, y: px.y / mapH };
}

function normToPx(n: Vec, mapW: number, mapH: number): Vec {
  return { x: n.x * mapW, y: n.y * mapH };
}

/**
 * 掌高深度：0=指根，1=腕（沿 down 投影）
 * 横向：相对该深度中轴点，沿 across 的偏移（相对 palmW）
 */
function palmCoords(n: Vec, frame: PalmFrame): { depth: number; lateral: number } {
  const { fingerBase, down, across, palmH, palmW } = frame;
  const dx = n.x - fingerBase.x;
  const dy = n.y - fingerBase.y;
  const depth = (dx * down.x + dy * down.y) / (palmH || 1);
  const onAxis = {
    x: fingerBase.x + down.x * depth * palmH,
    y: fingerBase.y + down.y * depth * palmH,
  };
  const lateral =
    ((n.x - onAxis.x) * across.x + (n.y - onAxis.y) * across.y) / (palmW || 1);
  return { depth, lateral };
}

function fromPalmCoords(
  depth: number,
  lateral: number,
  frame: PalmFrame,
): Vec {
  return {
    x:
      frame.fingerBase.x +
      frame.down.x * depth * frame.palmH +
      frame.across.x * lateral * frame.palmW,
    y:
      frame.fingerBase.y +
      frame.down.y * depth * frame.palmH +
      frame.across.y * lateral * frame.palmW,
  };
}

function thumbSideSign(frame: PalmFrame): number {
  const { thumbMcp, palmCenter, across } = frame;
  const thumbSide =
    (thumbMcp.x - palmCenter.x) * across.x +
    (thumbMcp.y - palmCenter.y) * across.y;
  return thumbSide >= 0 ? 1 : -1;
}

function inRoi(n: Vec, frame: PalmFrame, lineId: PalmLineId): boolean {
  const roi = LINE_ROI[lineId];
  const { depth, lateral } = palmCoords(n, frame);

  if (depth < roi.depthMin - 0.04 || depth > roi.depthMax + 0.04) return false;

  if (lineId === "life") {
    const sideSign = thumbSideSign(frame);
    // 允许从掌中到拇指外缘，禁止偏向小指侧深处
    if (sideSign * lateral < -0.15) return false;
    if (Math.abs(lateral) > 0.55) return false;
    return true;
  }

  if (lineId === "career") {
    return Math.abs(lateral) <= roi.lateralPad + 0.08;
  }

  // heart / head：横贯掌宽
  return Math.abs(lateral) <= 0.55 + roi.lateralPad;
}

/** 将点投影回 ROI 带内 */
function clampToRoi(n: Vec, frame: PalmFrame, lineId: PalmLineId): Vec {
  const roi = LINE_ROI[lineId];
  let { depth, lateral } = palmCoords(n, frame);
  depth = Math.min(roi.depthMax, Math.max(roi.depthMin, depth));

  if (lineId === "career") {
    lateral = Math.min(roi.lateralPad, Math.max(-roi.lateralPad, lateral));
  } else if (lineId === "life") {
    const sideSign = thumbSideSign(frame);
    if (sideSign * lateral < -0.1) lateral = -0.1 * sideSign;
    lateral = Math.min(0.5, Math.max(-0.5, lateral));
  } else {
    lateral = Math.min(0.55, Math.max(-0.55, lateral));
  }

  return fromPalmCoords(depth, lateral, frame);
}

/**
 * 方向一致性：候选位移后的局部切线应与偏好方向对齐。
 * 返回 0～1 权重（越高越好）。
 */
function directionScore(
  tx: number,
  ty: number,
  frame: PalmFrame,
  lineId: PalmLineId,
): number {
  const prefer = LINE_ROI[lineId].preferDir;
  const tlen = Math.hypot(tx, ty) || 1;
  const ux = tx / tlen;
  const uy = ty / tlen;

  if (prefer === "across") {
    const dot = Math.abs(ux * frame.across.x + uy * frame.across.y);
    return dot; // 1 = 完全横向
  }
  if (prefer === "down") {
    const dot = Math.abs(ux * frame.down.x + uy * frame.down.y);
    return dot;
  }
  // life：弧线，允许对角；惩罚纯横向横穿掌心中部
  const acrossDot = Math.abs(ux * frame.across.x + uy * frame.across.y);
  const downDot = Math.abs(ux * frame.down.x + uy * frame.down.y);
  return 0.35 + 0.65 * Math.max(acrossDot, downDot) * (1 - acrossDot * 0.3);
}

function snapOnePath(
  path: PalmPoint[],
  map: CreaseMap,
  lineId: PalmLineId,
  frame: PalmFrame,
): PalmPoint[] {
  if (path.length < 2) return path;
  const cfg = LINE_SNAP[lineId];
  let pts = densify(path, 14).map((p) => pctToPx(p, map.width, map.height));

  for (let pass = 0; pass < cfg.passes; pass += 1) {
    const next: Vec[] = [];
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

      const centerNorm = pxToNorm(cur, map.width, map.height);
      const centerScore = sample(map, cur.x, cur.y);
      let bestD = 0;
      let bestScore = centerScore;

      for (let d = -cfg.radius; d <= cfg.radius; d += 1) {
        if (d === 0) continue;
        const cand: Vec = { x: cur.x + nx * d, y: cur.y + ny * d };
        const candNorm = pxToNorm(cand, map.width, map.height);
        if (!inRoi(candNorm, frame, lineId)) continue;

        let sc = sample(map, cand.x, cand.y);
        // 方向偏好：横向线惩罚纵向吸附造成的切线扭曲
        const dirW = directionScore(tx, ty, frame, lineId);
        sc *= 0.7 + 0.3 * dirW;

        if (sc > bestScore) {
          bestScore = sc;
          bestD = d;
        }
      }

      const isEnd = i === 0 || i === pts.length - 1;
      const gain = bestScore - centerScore;
      const allow =
        !isEnd && bestD !== 0 && gain >= cfg.minGain
          ? bestD
          : isEnd && gain >= cfg.minGain * 1.5
            ? Math.round(bestD * 0.35)
            : 0;

      let moved: Vec = {
        x: cur.x + nx * allow,
        y: cur.y + ny * allow,
      };
      let movedNorm = pxToNorm(moved, map.width, map.height);
      if (!inRoi(movedNorm, frame, lineId)) {
        movedNorm = clampToRoi(movedNorm, frame, lineId);
        moved = normToPx(movedNorm, map.width, map.height);
      } else if (!inRoi(centerNorm, frame, lineId) && allow === 0) {
        // 初值偶发出带：拉回
        moved = normToPx(clampToRoi(centerNorm, frame, lineId), map.width, map.height);
      }

      next.push(moved);
    }
    pts = next;
  }

  const pct = pts.map((p) => pxToPct(p, map.width, map.height));
  return strongSmooth(pct);
}

/**
 * 在事业线细长 ROI 内采样纵向 valley 能量。
 * 沿腕→中指主轴取点，比较「沿 across 的局部暗沟」响应。
 */
function measureCareerTexture(map: CreaseMap, frame: PalmFrame): number {
  const { wrist, middleMcp, down, across, palmW, palmH } = frame;
  const top = {
    x: middleMcp.x + down.x * palmH * 0.4,
    y: middleMcp.y + down.y * palmH * 0.4,
  };
  const base = {
    x: wrist.x + (frame.palmCenter.x - wrist.x) * 0.1,
    y: wrist.y + (frame.palmCenter.y - wrist.y) * 0.1,
  };

  let sum = 0;
  let count = 0;
  for (let i = 0; i < CAREER_TEXTURE_SAMPLES; i += 1) {
    const t = i / (CAREER_TEXTURE_SAMPLES - 1);
    const cx = base.x + (top.x - base.x) * t;
    const cy = base.y + (top.y - base.y) * t;
    // 在法线（across）方向找最大 valley，模拟纵向沟
    let best = -1e9;
    const radius = Math.max(2, Math.round(palmW * map.width * 0.08));
    for (let d = -radius; d <= radius; d += 1) {
      const px = cx * map.width + across.x * d;
      const py = cy * map.height + across.y * d;
      const n = { x: px / map.width, y: py / map.height };
      if (!inRoi(n, frame, "career")) continue;
      best = Math.max(best, sample(map, px, py));
    }
    if (best > -1e8) {
      sum += best;
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** 把解剖示意线沿法线吸附到图像中的真实暗沟（限制在生理 ROI 内） */
export async function snapPathsToCreases(
  imageBytes: Buffer,
  paths: PalmPathMap,
  frame: PalmFrame,
): Promise<PalmPathMap> {
  const map = await buildCreaseMap(imageBytes);

  const heart = snapOnePath(paths.heart, map, "heart", frame);
  const head = snapOnePath(paths.head, map, "head", frame);
  const life = snapOnePath(paths.life, map, "life", frame);

  const result: PalmPathMap = { heart, head, life };

  // 事业线：仅当 ROI 内有明显纵向纹理时才吸附并保留
  if (paths.career && paths.career.length >= 2) {
    const texture = measureCareerTexture(map, frame);
    if (texture >= CAREER_TEXTURE_MIN) {
      result.career = snapOnePath(paths.career, map, "career", frame);
    }
    // else: omit career
  }

  return result;
}
