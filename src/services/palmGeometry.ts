import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-cpu";
import * as handPoseDetection from "@tensorflow-models/hand-pose-detection";
import sharp from "sharp";

import { settings } from "../config.js";

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
 * 用 21 关键点在掌心局部生成 Chance 风格示意主线（贴掌形，非像素沟壑追踪）。
 * 坐标系：归一化图像坐标 0–1 → 输出 0–100。
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

  // 掌心坐标系：down 朝腕，across 从小指侧 → 食指侧
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

  /** 把点往掌心收一点，避免画到背景 / 指缝外 */
  const inset = (p: Landmark, amount = 0.12): Landmark =>
    lerp(p, palmCenter, amount);

  const along = (p: Landmark, dx: number, dy: number): Landmark =>
    add(p, dx, dy);

  // 感情线：贴指根下方真实横沟位置（比 MCP 更靠腕约 18–24% 掌高）
  const heartStart = inset(
    along(pinkyMcp, down.x * palmH * 0.2, down.y * palmH * 0.2),
    0.1,
  );
  const heartMid1 = inset(
    along(
      lerp(pinkyMcp, ringMcp, 0.5),
      down.x * palmH * 0.22,
      down.y * palmH * 0.22,
    ),
    0.08,
  );
  const heartMid2 = inset(
    along(
      lerp(ringMcp, middleMcp, 0.4),
      down.x * palmH * 0.24,
      down.y * palmH * 0.24,
    ),
    0.06,
  );
  // 末端略弯向食指侧，接近真实感情线走向
  const heartEnd = inset(
    along(
      lerp(indexMcp, middleMcp, 0.25),
      down.x * palmH * 0.18 + across.x * palmW * -0.02,
      down.y * palmH * 0.18 + across.y * palmW * -0.02,
    ),
    0.1,
  );

  // 智慧线：虎口 → 小指侧，明显低于感情线
  const headStart = inset(lerp(thumbMcp, indexMcp, 0.55), 0.08);
  const headMid1 = inset(
    along(
      lerp(indexMcp, middleMcp, 0.35),
      down.x * palmH * 0.34,
      down.y * palmH * 0.34,
    ),
    0.05,
  );
  const headMid2 = inset(
    along(
      lerp(middleMcp, ringMcp, 0.55),
      down.x * palmH * 0.38,
      down.y * palmH * 0.38,
    ),
    0.05,
  );
  const headEnd = inset(
    along(pinkyMcp, down.x * palmH * 0.4, down.y * palmH * 0.4),
    0.12,
  );

  // 生命线：紧贴拇指丘弧，不甩到掌心中央
  const lifeStart = inset(lerp(indexMcp, thumbMcp, 0.42), 0.05);
  const lifeMid1 = lerp(thumbMcp, thumbCmc, 0.25);
  const lifeMid2 = along(
    lerp(thumbCmc, wrist, 0.35),
    across.x * palmW * 0.04,
    across.y * palmW * 0.04,
  );
  const lifeEnd = lerp(wrist, thumbCmc, 0.22);

  // 事业线：腕中 → 中指根方向，止于掌心上半，避开感情线与指根
  const careerAxisEnd = lerp(wrist, middleMcp, 0.62);
  const careerStart = lerp(wrist, careerAxisEnd, 0.08);
  const careerMid1 = lerp(wrist, careerAxisEnd, 0.32);
  const careerMid2 = lerp(wrist, careerAxisEnd, 0.55);
  const careerEnd = lerp(wrist, careerAxisEnd, 0.88);

  return {
    heart: samplePolyline([heartStart, heartMid1, heartMid2, heartEnd], 8),
    head: samplePolyline([headStart, headMid1, headMid2, headEnd], 8),
    life: samplePolyline([lifeStart, lifeMid1, lifeMid2, lifeEnd], 8),
    career: samplePolyline(
      [careerStart, careerMid1, careerMid2, careerEnd],
      8,
    ),
  };
}

/** 无关键点时：在画面中心偏下的掌心矩形内放相对稳定的示意线 */
export function buildFallbackPaths(): PalmPathMap {
  // 假设掌心约占画面中部（拍照引导后常见构图）
  const box = { left: 22, top: 18, right: 78, bottom: 88 };
  const lx = (t: number) => box.left + (box.right - box.left) * t;
  const ly = (t: number) => box.top + (box.bottom - box.top) * t;

  return {
    heart: samplePolyline(
      [
        { x: lx(0.92) / 100, y: ly(0.28) / 100 },
        { x: lx(0.7) / 100, y: ly(0.24) / 100 },
        { x: lx(0.45) / 100, y: ly(0.22) / 100 },
        { x: lx(0.22) / 100, y: ly(0.26) / 100 },
      ],
      7,
    ),
    head: samplePolyline(
      [
        { x: lx(0.2) / 100, y: ly(0.38) / 100 },
        { x: lx(0.42) / 100, y: ly(0.4) / 100 },
        { x: lx(0.65) / 100, y: ly(0.44) / 100 },
        { x: lx(0.88) / 100, y: ly(0.5) / 100 },
      ],
      7,
    ),
    life: samplePolyline(
      [
        { x: lx(0.28) / 100, y: ly(0.3) / 100 },
        { x: lx(0.2) / 100, y: ly(0.45) / 100 },
        { x: lx(0.18) / 100, y: ly(0.62) / 100 },
        { x: lx(0.28) / 100, y: ly(0.82) / 100 },
      ],
      7,
    ),
    career: samplePolyline(
      [
        { x: lx(0.5) / 100, y: ly(0.85) / 100 },
        { x: lx(0.51) / 100, y: ly(0.65) / 100 },
        { x: lx(0.52) / 100, y: ly(0.45) / 100 },
        { x: lx(0.53) / 100, y: ly(0.28) / 100 },
      ],
      7,
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

  // hand-pose-detection 接受 Tensor3D [h,w,3]
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

    // keypoints 是像素坐标（相对输入 tensor）
    const kps = hands[0]!.keypoints;
    return kps.map((kp) => ({
      x: kp.x / info.width,
      y: kp.y / info.height,
    }));
  } finally {
    rgb.dispose();
  }
}

/**
 * 检测手部关键点并生成四条主线 path（0–100）。
 * 检测失败时回退到中心掌心模板，保证前端始终有可贴合掌区的线。
 */
export async function resolvePalmPaths(
  imageBytes: Buffer,
): Promise<{ paths: PalmPathMap; source: "landmarks" | "fallback" }> {
  try {
    const landmarks = await detectLandmarks(imageBytes);
    if (landmarks && landmarks.length >= 18) {
      if (settings.debug) {
        console.log("[palmGeometry] landmarks ok", landmarks.length);
      }
      return { paths: buildPathsFromLandmarks(landmarks), source: "landmarks" };
    }
  } catch (err) {
    console.warn(
      "[palmGeometry] landmark detect failed, using fallback:",
      err instanceof Error ? err.message : err,
    );
  }
  return { paths: buildFallbackPaths(), source: "fallback" };
}
