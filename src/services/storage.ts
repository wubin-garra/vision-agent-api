import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { settings } from "../config.js";

export class StorageService {
  readonly uploadDir: string;

  constructor() {
    this.uploadDir = path.resolve(settings.uploadDir);
    mkdirSync(this.uploadDir, { recursive: true });
  }

  async saveImage(
    data: Buffer,
    prefix = "img",
  ): Promise<{ imageId: string; filename: string; processed: Buffer }> {
    const imageId = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const processed = await this.processImage(data);
    const filename = `${imageId}.jpg`;
    const thumbFilename = `${imageId}_thumb.jpg`;

    await writeFile(path.join(this.uploadDir, filename), processed);
    const thumb = await this.makeThumbnail(processed);
    await writeFile(path.join(this.uploadDir, thumbFilename), thumb);

    return { imageId, filename, processed };
  }

  getImagePath(filename: string): string {
    return path.join(this.uploadDir, filename);
  }

  async readImageBytes(filename: string): Promise<Buffer> {
    return readFile(this.getImagePath(filename));
  }

  private async processImage(data: Buffer): Promise<Buffer> {
    return sharp(data)
      .rotate()
      .resize({
        width: settings.maxImageSize,
        height: settings.maxImageSize,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
  }

  private async makeThumbnail(data: Buffer, size = 256): Promise<Buffer> {
    return sharp(data)
      .resize({
        width: size,
        height: size,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
  }
}

export const storageService = new StorageService();
