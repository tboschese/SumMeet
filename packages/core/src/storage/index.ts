import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Storage abstraction (SPEC §7.7). The MVP impl writes to local disk under
 * `${baseDir}/{key}`; an R2/S3 impl drops in behind the same interface later.
 * The DB stores only the key (e.g. "{meetingId}.webm"), never an absolute path.
 */
export interface StorageProvider {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /**
   * Absolute path for a key, when the backend is local disk. Lets the pipeline
   * hand ffmpeg a real file. Remote backends won't implement this.
   */
  localPath?(key: string): string;
}

export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly baseDir: string) {}

  localPath(key: string): string {
    return path.join(this.baseDir, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.localPath(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.localPath(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.localPath(key), { force: true });
  }
}
