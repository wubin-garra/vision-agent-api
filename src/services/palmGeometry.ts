import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-cpu";
import * as handPoseDetection from "@tensorflow-models/hand-pose-detection";
import sharp from "sharp";

import { settings } from "../config.js";
import { snapPathsToCreases } from "./palmCreaseSnap.js";

export type PalmPoint = { x: number; y: number };
export type PalmLineId = "heart" | "head" | "life" | "career";

/** heart/head/life 必有；career 仅在检测到明显纵向纹理时存在 */
export type PalmPathMap = {
  heart: PalmPoint[];
  head: PalmPoint[];
  life: PalmPoint[];
  career?: PalmPoint[];
};

/** MediaPipe Hands 关键点索引 */
const LM = {
  wrist: 0,
  thumbCmc: 1,
  thumbMcp: 2,
  indexMcp: 5,
  middleMcp: 9,
  ringMcp: 13,
  pinkyMcp: 17,
} as const;

type Landmark = { x: number; y: number };

/** 掌坐标系：用于 ROI 与初值（归一化 0–1 图像坐标） */
export type PalmFrame = {
  wrist: Landmark;
  fingerBase: Landmark;
  palmCenter: Landmark;
  /** 指根 → 腕，单位向量 */
  down: Landmark;
  /** 小指 → 食指方向的单位向量（across 指向食指侧） */
  across: Landmark;
  palmW: number;
  palmH: number;
  huKou: Landmark;
  indexMcp: Landmark;
  middleMcp: Landmark;
  ringMcp: Landmark;
  pinkyMcp: Landmark;
  thumbMcp: Landmark;
  thumbCmc: Landmark;
};

let detectorPromise: Promise<handPoseDetection.HandDetector> | null = null;

async function getDetector(): Promise<handPoseDetection.HandDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      await tf.setBackend("cpu");
      await tf.ready();
      return handPoseDetection.createDetector(
        handPoseDetection.SupportedModels.MediaPipeHands,
        {
          runtime: "tfjs",
          modelType: "lite",
          maxHands: 1,
        },
      );
    })().catch((err) => {
      detectorPromise = null;
      throw err;
    });
  }
  return detectorPromise;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function toPct(p: Landmark): PalmPoint {
  return {
    x: Math.round(clamp01(p.x) * 1000) / 10,
    y: Math.round(clamp01(p.y) * 1000) / 10,
  };
}

function lerp(a: Landmark, b: Landmark, t: number): Landmark {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function add(a: Landmark, dx: number, dy: number): Landmark {
  return { x: a.x + dx, y: a.y + dy };
}

function samplePolyline(points: Landmark[], count = 7): PalmPoint[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [toPct(points[0]!)];

  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segLens.push(len);
    total += len;
  }
  if (total <= 1e-6) return points.map(toPct);

  const out: PalmPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const target = (i / (count - 1)) * total;
    let acc = 0;
    let chosen = points[points.length - 1]!;
    for (let s = 0; s < segLens.length; s += 1) {
      const nextAcc = acc + segLens[s]!;
      if (target <= nextAcc || s === segLens.length - 1) {
        const t = segLens[s]! <= 1e-6 ? 0 : (target - acc) / segLens[s]!;
        chosen = lerp(points[s]!, points[s + 1]!, Math.min(1, Math.max(0, t)));
        break;
      }
      acc = nextAcc;
    }
    out.push(toPct(chosen));
  }
  return out;
}

/** 从关键点构建掌坐标系 */
export function buildPalmFrame(landmarks: Landmark[]): PalmFrame {
  const wrist = landmarks[LM.wrist]!;
  const thumbMcp = landmarks[LM.thumbMcp]!;
  const thumbCmc = landmarks[LM.thumbCmc]!;
  const indexMcp = landmarks[LM.indexMcp]!;
  const middleMcp = landmarks[LM.middleMcp]!;
  const ringMcp = landmarks[LM.ringMcp]!;
  const pinkyMcp = landmarks[LM.pinkyMcp]!;

  const palmW =
    Math.hypot(pinkyMcp.x - indexMcp.x, pinkyMcp.y - indexMcp.y) || 0.2;
  const palmH =
    Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y) || 0.3;

  const down: Landmark = {
    x: (wrist.x - middleMcp.x) / (palmH || 1),
    y: (wrist.y - middleMcp.y) / (palmH || 1),
  };
  const acrossRaw: Landmark = {
    x: (indexMcp.x - pinkyMcp.x) / (palmW || 1),
    y: (indexMcp.y - pinkyMcp.y) / (palmW || 1),
  };
  const acrossLen = Math.hypot(acrossRaw.x, acrossRaw.y) || 1;
  const across: Landmark = {
    x: acrossRaw.x / acrossLen,
    y: acrossRaw.y / acrossLen,
  };

  const fingerBase = lerp(
    lerp(indexMcp, middleMcp, 0.5),
    lerp(ringMcp, pinkyMcp, 0.5),
    0.5,
  );
  const palmCenter = lerp(wrist, fingerBase, 0.45);
  const inset = (p: Landmark, amount = 0.12): Landmark =>
    lerp(p, palmCenter, amount);
  const huKou = inset(lerp(indexMcp, thumbMcp, 0.52), 0.06);

  return {
    wrist,
    fingerBase,
    palmCenter,
    down,
    across,
    palmW,
    palmH,
    huKou,
    indexMcp,
    middleMcp,
    ringMcp,
    pinkyMcp,
    thumbMcp,
    thumbCmc,
  };
}

/** 无关键点时的近似掌坐标系（画面中部掌区） */
export function buildFallbackFrame(): PalmFrame {
  const box = { left: 0.22, top: 0.18, right: 0.78, bottom: 0.88 };
  const midX = (box.left + box.right) / 2;
  const wrist = { x: midX, y: box.bottom };
  const fingerBase = { x: midX, y: box.top };
  const palmH = box.bottom - box.top;
  const palmW = box.right - box.left;
  return {
    wrist,
    fingerBase,
    palmCenter: { x: midX, y: (box.top + box.bottom) / 2 },
    down: { x: 0, y: 1 },
    across: { x: 1, y: 0 },
    palmW,
    palmH,
    huKou: { x: box.left + palmW * 0.28, y: box.top + palmH * 0.3 },
    indexMcp: { x: box.left + palmW * 0.22, y: box.top },
    middleMcp: { x: midX, y: box.top },
    ringMcp: { x: box.left + palmW * 0.68, y: box.top },
    pinkyMcp: { x: box.right, y: box.top + palmH * 0.02 },
    thumbMcp: { x: box.left + palmW * 0.08, y: box.top + palmH * 0.35 },
    thumbCmc: { x: box.left + palmW * 0.12, y: box.top + palmH * 0.55 },
  };
}

/**
 * 用 21 关键点生成四条主线解剖初值（示意线，落在生理搜索带内）。
 *
 * - 感情线：四指根下方，掌高 20%～40%（中心约 30%）
 * - 智慧线：虎口起横贯，掌高 35%～60%
 * - 生命线：虎口 → 拇指球外缘 → 腕侧
 * - 事业线：腕中 → 中指方向近直弧（无人造 wobble）；是否保留由 crease 门控决定
 */
export function buildPathsFromLandmarks(landmarks: Landmark[]): {
  paths: PalmPathMap;
  frame: PalmFrame;
} {
  const frame = buildPalmFrame(landmarks);
  const {
    down,
    across,
    palmH,
    palmW,
    palmCenter,
    huKou,
    indexMcp,
    middleMcp,
    ringMcp,
    pinkyMcp,
    thumbMcp,
    thumbCmc,
    wrist,
  } = frame;

  const inset = (p: Landmark, amount = 0.12): Landmark =>
    lerp(p, palmCenter, amount);
  const along = (p: Landmark, dx: number, dy: number): Landmark =>
    add(p, dx, dy);

  // —— 感情线：掌高 20%～40%，中心约 0.30；小指侧 → 食指侧 ——
  const heartD = palmH * 0.3;
  const heartArc = palmH * 0.04; // 轻微上弧，更贴近生理感情线
  const heartStart = inset(
    along(pinkyMcp, down.x * heartD * 0.92, down.y * heartD * 0.92),
    0.06,
  );
  const heartMid1 = inset(
    along(
      lerp(pinkyMcp, ringMcp, 0.55),
      down.x * (heartD - heartArc),
      down.y * (heartD - heartArc),
    ),
    0.05,
  );
  const heartMid2 = inset(
    along(
      lerp(ringMcp, middleMcp, 0.45),
      down.x * (heartD - heartArc * 1.2),
      down.y * (heartD - heartArc * 1.2),
    ),
    0.04,
  );
  const heartEnd = inset(
    along(
      lerp(indexMcp, middleMcp, 0.28),
      down.x * heartD * 0.88,
      down.y * heartD * 0.88,
    ),
    0.06,
  );

  // —— 智慧线：虎口起，掌高约 0.45 中心，落在 35%～60% ——
  const headD = palmH * 0.46;
  const headStart = along(huKou, down.x * palmH * 0.14, down.y * palmH * 0.14);
  const headMid1 = inset(
    along(lerp(indexMcp, middleMcp, 0.4), down.x * headD, down.y * headD),
    0.05,
  );
  const headMid2 = inset(
    along(
      lerp(middleMcp, ringMcp, 0.5),
      down.x * (headD + palmH * 0.04),
      down.y * (headD + palmH * 0.04),
    ),
    0.05,
  );
  const headEnd = inset(
    along(
      pinkyMcp,
      down.x * (headD + palmH * 0.08),
      down.y * (headD + palmH * 0.08),
    ),
    0.12,
  );

  // —— 生命线：虎口 → 拇指球外缘 → 腕侧（平滑弧）——
  const lifeStart = huKou;
  const lifeMid1 = lerp(huKou, lerp(palmCenter, thumbMcp, 0.82), 0.5);
  const lifeMid2 = lerp(palmCenter, thumbMcp, 0.88);
  const lifeMid3 = lerp(palmCenter, thumbCmc, 0.9);
  const lifeMid4 = lerp(palmCenter, lerp(thumbCmc, wrist, 0.4), 0.78);
  const lifeEnd = lerp(wrist, thumbCmc, 0.45);

  // —— 事业线：腕中偏掌心 → 中指方向，近直柔和弧，无 wobble ——
  const careerBase = along(
    wrist,
    across.x * palmW * -0.02 + (palmCenter.x - wrist.x) * 0.08,
    across.y * palmW * -0.02 + (palmCenter.y - wrist.y) * 0.08,
  );
  const careerTop = along(
    lerp(middleMcp, ringMcp, 0.15),
    down.x * headD * 0.9,
    down.y * headD * 0.9,
  );
  // 极轻侧弯（生理自然微弧，非人造 zigzag）
  const careerSide = across.x * palmW * 0.012;
  const careerSideY = across.y * palmW * 0.012;

  const paths: PalmPathMap = {
    heart: samplePolyline([heartStart, heartMid1, heartMid2, heartEnd], 8),
    head: samplePolyline([headStart, headMid1, headMid2, headEnd], 8),
    life: samplePolyline(
      [lifeStart, lifeMid1, lifeMid2, lifeMid3, lifeMid4, lifeEnd],
      9,
    ),
    career: samplePolyline(
      [
        careerBase,
        along(lerp(careerBase, careerTop, 0.25), careerSide, careerSideY),
        lerp(careerBase, careerTop, 0.5),
        along(lerp(careerBase, careerTop, 0.75), -careerSide * 0.5, -careerSideY * 0.5),
        careerTop,
      ],
      9,
    ),
  };

  return { paths, frame };
}

/** 无关键点时：按同样解剖比例放在画面中部掌区 */
export function buildFallbackPaths(): {
  paths: PalmPathMap;
  frame: PalmFrame;
} {
  const frame = buildFallbackFrame();
  const box = { left: 22, top: 18, right: 78, bottom: 88 };
  const lx = (t: number) => box.left + (box.right - box.left) * t;
  const ly = (t: number) => box.top + (box.bottom - box.top) * t;

  const paths: PalmPathMap = {
    // 感情线：掌高约 28%～32%（指根下 20–40% 带内）
    heart: samplePolyline(
      [
        { x: lx(0.9) / 100, y: ly(0.3) / 100 },
        { x: lx(0.68) / 100, y: ly(0.27) / 100 },
        { x: lx(0.42) / 100, y: ly(0.26) / 100 },
        { x: lx(0.22) / 100, y: ly(0.29) / 100 },
      ],
      8,
    ),
    // 智慧线：掌高约 45%～55%
    head: samplePolyline(
      [
        { x: lx(0.26) / 100, y: ly(0.42) / 100 },
        { x: lx(0.45) / 100, y: ly(0.46) / 100 },
        { x: lx(0.68) / 100, y: ly(0.5) / 100 },
        { x: lx(0.88) / 100, y: ly(0.54) / 100 },
      ],
      8,
    ),
    // 生命线：虎口 → 拇指侧 → 腕
    life: samplePolyline(
      [
        { x: lx(0.28) / 100, y: ly(0.32) / 100 },
        { x: lx(0.16) / 100, y: ly(0.42) / 100 },
        { x: lx(0.12) / 100, y: ly(0.56) / 100 },
        { x: lx(0.18) / 100, y: ly(0.74) / 100 },
        { x: lx(0.34) / 100, y: ly(0.88) / 100 },
      ],
      9,
    ),
    // 事业线：近直，腕中 → 中指
    career: samplePolyline(
      [
        { x: lx(0.52) / 100, y: ly(0.88) / 100 },
        { x: lx(0.53) / 100, y: ly(0.7) / 100 },
        { x: lx(0.52) / 100, y: ly(0.52) / 100 },
        { x: lx(0.53) / 100, y: ly(0.4) / 100 },
      ],
      9,
    ),
  };

  return { paths, frame };
}

async function detectLandmarks(
  imageBytes: Buffer,
): Promise<Landmark[] | null> {
  const maxSide = 640;
  const meta = await sharp(imageBytes).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return null;

  const scale = Math.min(1, maxSide / Math.max(w, h));
  const rw = Math.max(1, Math.round(w * scale));
  const rh = Math.max(1, Math.round(h * scale));

  const { data, info } = await sharp(imageBytes)
    .rotate()
    .resize(rw, rh, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const detector = await getDetector();

  const rgb = tf.tidy(() => {
    const t4 = tf.tensor3d(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      [info.height, info.width, 4],
      "int32",
    );
    return t4.slice([0, 0, 0], [-1, -1, 3]) as tf.Tensor3D;
  });

  try {
    const hands = await detector.estimateHands(rgb, { flipHorizontal: false });
    if (!hands.length || !hands[0]?.keypoints?.length) return null;

    const kps = hands[0]!.keypoints;
    return kps.map((kp) => ({
      x: kp.x / info.width,
      y: kp.y / info.height,
    }));
  } finally {
    rgb.dispose();
  }
}

export async function resolvePalmPaths(
  imageBytes: Buffer,
): Promise<{ paths: PalmPathMap; source: "landmarks" | "fallback" }> {
  let paths: PalmPathMap;
  let frame: PalmFrame;
  let source: "landmarks" | "fallback" = "fallback";

  try {
    const landmarks = await detectLandmarks(imageBytes);
    if (landmarks && landmarks.length >= 18) {
      const built = buildPathsFromLandmarks(landmarks);
      paths = built.paths;
      frame = built.frame;
      source = "landmarks";
      if (settings.debug) {
        console.log("[palmGeometry] landmarks ok", landmarks.length);
      }
    } else {
      const built = buildFallbackPaths();
      paths = built.paths;
      frame = built.frame;
    }
  } catch (err) {
    console.warn(
      "[palmGeometry] landmark detect failed, using fallback:",
      err instanceof Error ? err.message : err,
    );
    const built = buildFallbackPaths();
    paths = built.paths;
    frame = built.frame;
  }

  // 解剖初值 → 在 ROI 内沿法线吸附真实暗沟
  try {
    paths = await snapPathsToCreases(imageBytes, paths, frame);
    if (settings.debug) {
      console.log(`[palmGeometry] crease snap ok (source=${source})`);
    }
  } catch (err) {
    console.warn(
      "[palmGeometry] crease snap failed, keeping anatomical paths:",
      err instanceof Error ? err.message : err,
    );
  }

  return { paths, source };
}
