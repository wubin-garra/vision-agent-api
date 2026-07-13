import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { settings } from "../config.js";

export type MemoryRecord = {
  id: string;
  user_id: string;
  title: string;
  category: string;
  agent_id: string;
  image_filename: string;
  thumbnail_filename: string;
  insight_json: string;
  locale: string;
  followups_json: string;
  image_caption: string;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
};

export class MemoryRepository {
  private readonly db: Database.Database;

  constructor(dbPath = settings.databasePath) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT DEFAULT 'anonymous',
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        image_filename TEXT NOT NULL,
        thumbnail_filename TEXT NOT NULL,
        insight_json TEXT NOT NULL,
        locale TEXT DEFAULT 'zh-CN',
        followups_json TEXT DEFAULT '[]',
        image_caption TEXT DEFAULT '',
        latitude REAL,
        longitude REAL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
    `);

    const columns = this.db
      .prepare("PRAGMA table_info(memories)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    if (!names.has("image_caption")) {
      this.db.exec(
        "ALTER TABLE memories ADD COLUMN image_caption TEXT DEFAULT ''",
      );
    }
    if (!names.has("latitude")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN latitude REAL");
    }
    if (!names.has("longitude")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN longitude REAL");
    }
  }

  create(input: {
    title: string;
    category: string;
    agent_id: string;
    image_filename: string;
    thumbnail_filename: string;
    insight: unknown;
    locale: string;
    user_id?: string;
    image_caption?: string;
    latitude?: number | null;
    longitude?: number | null;
  }): MemoryRecord {
    const record: MemoryRecord = {
      id: randomUUID(),
      user_id: input.user_id ?? "anonymous",
      title: input.title,
      category: input.category,
      agent_id: input.agent_id,
      image_filename: input.image_filename,
      thumbnail_filename: input.thumbnail_filename,
      insight_json: JSON.stringify(input.insight),
      locale: input.locale,
      followups_json: "[]",
      image_caption: input.image_caption ?? "",
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      created_at: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO memories (
          id, user_id, title, category, agent_id, image_filename, thumbnail_filename,
          insight_json, locale, followups_json, image_caption, latitude, longitude, created_at
        ) VALUES (
          @id, @user_id, @title, @category, @agent_id, @image_filename, @thumbnail_filename,
          @insight_json, @locale, @followups_json, @image_caption, @latitude, @longitude, @created_at
        )`,
      )
      .run(record);

    return record;
  }

  get(memoryId: string): MemoryRecord | undefined {
    return this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(memoryId) as MemoryRecord | undefined;
  }

  listAll(userId = "anonymous", limit = 50): MemoryRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM memories
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as MemoryRecord[];
  }

  appendFollowup(memoryId: string, question: string, answer: string): void {
    const record = this.get(memoryId);
    if (!record) return;

    const followups = JSON.parse(record.followups_json || "[]") as unknown[];
    followups.push({
      question,
      answer,
      at: new Date().toISOString(),
    });

    this.db
      .prepare("UPDATE memories SET followups_json = ? WHERE id = ?")
      .run(JSON.stringify(followups), memoryId);
  }
}

export const memoryRepository = new MemoryRepository();
