import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-cpu";
import * as handPoseDetection from "@tensorflow-models/hand-pose-detection";
import sharp from "sharp";

import { settings } from "../config.js";
import { snapPathsToCreases } from "./palmCreaseSnap.js";

export type PalmPoint = { x: number; y: number };
export type PalmLineId = "heart" | "head" | "life" | "career";
export type PalmPathMap = Record<PalmLineId, PalmPoint[]>;

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

/**
 * 用 21 关键点生成四条主线（示意线，贴掌形解剖位置）。
 *
 * - 感情线：紧贴四指 MCP 根部下方的上方横纹
 * - 智慧线：掌中部，与感情线明显分离，多起于虎口
 * - 生命线：上端接虎口，绕拇指丘落到腕侧
 * - 事业线：腕→中指方向的柔和曲线，止于智慧线下方
 */
export function buildPathsFromLandmarks(landmarks: Landmark[]): PalmPathMap {
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
  const toPinky = { x: -across.x, y: -across.y };

  const fingerBase = lerp(
    lerp(indexMcp, middleMcp, 0.5),
    lerp(ringMcp, pinkyMcp, 0.5),
    0.5,
  );
  const palmCenter = lerp(wrist, fingerBase, 0.45);

  const inset = (p: Landmark, amount = 0.12): Landmark =>
    lerp(p, palmCenter, amount);
  const along = (p: Landmark, dx: number, dy: number): Landmark =>
    add(p, dx, dy);

  // 虎口：食指 MCP ↔ 拇指 MCP
  const huKou = inset(lerp(indexMcp, thumbMcp, 0.52), 0.06);

  // —— 感情线：紧贴四指根下方（仅下沉约 8–12% 掌高）——
  const heartD = palmH * 0.1;
  const heartStart = inset(
    along(pinkyMcp, down.x * heartD * 0.85, down.y * heartD * 0.85),
    0.05,
  );
  const heartMid1 = inset(
    along(lerp(pinkyMcp, ringMcp, 0.55), down.x * heartD, down.y * heartD),
    0.04,
  );
  const heartMid2 = inset(
    along(
      lerp(ringMcp, middleMcp, 0.45),
      down.x * heartD * 1.05,
      down.y * heartD * 1.05,
    ),
    0.03,
  );
  const heartEnd = inset(
    along(
      lerp(indexMcp, middleMcp, 0.28),
      down.x * heartD * 0.75,
      down.y * heartD * 0.75,
    ),
    0.05,
  );

  // —— 智慧线：掌中横纹，整体比感情线低约 0.26 掌高，末端略斜向腕 ——
  const headD = palmH * 0.36;
  const headStart = along(huKou, down.x * palmH * 0.04, down.y * palmH * 0.04);
  const headMid1 = inset(
    along(lerp(indexMcp, middleMcp, 0.4), down.x * headD, down.y * headD),
    0.04,
  );
  const headMid2 = inset(
    along(
      lerp(middleMcp, ringMcp, 0.5),
      down.x * (headD + palmH * 0.04),
      down.y * (headD + palmH * 0.04),
    ),
    0.04,
  );
  const headEnd = inset(
    along(
      pinkyMcp,
      down.x * (headD + palmH * 0.08),
      down.y * (headD + palmH * 0.08),
    ),
    0.1,
  );

  // —— 生命线：上端明确接虎口，再绕拇指丘落到腕侧 ——
  const lifeStart = huKou;
  const lifeMid1 = lerp(huKou, lerp(palmCenter, thumbMcp, 0.78), 0.55);
  const lifeMid2 = lerp(palmCenter, thumbMcp, 0.8);
  const lifeMid3 = lerp(palmCenter, thumbCmc, 0.86);
  const lifeMid4 = lerp(palmCenter, lerp(thumbCmc, wrist, 0.35), 0.72);
  const lifeEnd = lerp(wrist, thumbCmc, 0.5);

  // —— 事业线：柔和弯曲，止于智慧线高度，避免假直竖线 ——
  const careerBase = along(
    wrist,
    toPinky.x * palmW * 0.12,
    toPinky.y * palmW * 0.12,
  );
  const careerTop = along(
    lerp(middleMcp, ringMcp, 0.22),
    down.x * headD * 0.92 + toPinky.x * palmW * 0.04,
    down.y * headD * 0.92 + toPinky.y * palmW * 0.04,
  );
  const careerP = (t: number, wobble: number) =>
    along(
      lerp(careerBase, careerTop, t),
      across.x * palmW * wobble,
      across.y * palmW * wobble,
    );

  return {
    heart: samplePolyline([heartStart, heartMid1, heartMid2, heartEnd], 8),
    head: samplePolyline([headStart, headMid1, headMid2, headEnd], 8),
    life: samplePolyline(
      [lifeStart, lifeMid1, lifeMid2, lifeMid3, lifeMid4, lifeEnd],
      9,
    ),
    career: samplePolyline(
      [
        careerP(0.04, 0.01),
        careerP(0.22, 0.035),
        careerP(0.42, -0.02),
        careerP(0.62, 0.03),
        careerP(0.8, -0.015),
        careerP(0.94, 0.01),
      ],
      9,
    ),
  };
}

/** 无关键点时：按同样解剖比例放在画面中部掌区 */
export function buildFallbackPaths(): PalmPathMap {
  const box = { left: 22, top: 18, right: 78, bottom: 88 };
  const lx = (t: number) => box.left + (box.right - box.left) * t;
  const ly = (t: number) => box.top + (box.bottom - box.top) * t;

  return {
    // 感情线：靠上，近指根
    heart: samplePolyline(
      [
        { x: lx(0.9) / 100, y: ly(0.18) / 100 },
        { x: lx(0.68) / 100, y: ly(0.16) / 100 },
        { x: lx(0.42) / 100, y: ly(0.15) / 100 },
        { x: lx(0.22) / 100, y: ly(0.17) / 100 },
      ],
      8,
    ),
    // 智慧线：明显更低，微斜
    head: samplePolyline(
      [
        { x: lx(0.26) / 100, y: ly(0.34) / 100 },
        { x: lx(0.45) / 100, y: ly(0.36) / 100 },
        { x: lx(0.68) / 100, y: ly(0.4) / 100 },
        { x: lx(0.88) / 100, y: ly(0.46) / 100 },
      ],
      8,
    ),
    // 生命线：上接虎口（左上近食指侧）
    life: samplePolyline(
      [
        { x: lx(0.28) / 100, y: ly(0.3) / 100 },
        { x: lx(0.18) / 100, y: ly(0.4) / 100 },
        { x: lx(0.14) / 100, y: ly(0.56) / 100 },
        { x: lx(0.2) / 100, y: ly(0.74) / 100 },
        { x: lx(0.34) / 100, y: ly(0.88) / 100 },
      ],
      9,
    ),
    // 事业线：微弯，不到指根
    career: samplePolyline(
      [
        { x: lx(0.54) / 100, y: ly(0.88) / 100 },
        { x: lx(0.57) / 100, y: ly(0.72) / 100 },
        { x: lx(0.52) / 100, y: ly(0.56) / 100 },
        { x: lx(0.56) / 100, y: ly(0.42) / 100 },
        { x: lx(0.53) / 100, y: ly(0.34) / 100 },
      ],
      9,
    ),
  };
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
  let source: "landmarks" | "fallback" = "fallback";

  try {
    const landmarks = await detectLandmarks(imageBytes);
    if (landmarks && landmarks.length >= 18) {
      paths = buildPathsFromLandmarks(landmarks);
      source = "landmarks";
      if (settings.debug) {
        console.log("[palmGeometry] landmarks ok", landmarks.length);
      }
    } else {
      paths = buildFallbackPaths();
    }
  } catch (err) {
    console.warn(
      "[palmGeometry] landmark detect failed, using fallback:",
      err instanceof Error ? err.message : err,
    );
    paths = buildFallbackPaths();
  }

  // 解剖初值 → 沿法线吸附真实暗沟（掌纹沟壑）
  try {
    paths = await snapPathsToCreases(imageBytes, paths);
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
