import fs from 'node:fs';
import path from 'node:path';

/**
 * 证据文件目录:<dataDir>/projects/<projectId>/captures/<captureId>/
 * 一次采集一个目录,所以重新采集不会覆盖旧证据。
 * 数据库里只存相对 dataDir 的路径,读写时统一在这里校验,不允许落到数据目录之外。
 */
export class Storage {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir);
    fs.mkdirSync(this.root, { recursive: true });
  }

  captureDirRel(projectId: number, captureId: number): string {
    return path.posix.join('projects', String(projectId), 'captures', String(captureId));
  }

  resolve(rel: string): string {
    const full = path.resolve(this.root, rel);
    const relative = path.relative(this.root, full);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('文件路径超出数据目录');
    }
    return full;
  }

  write(rel: string, data: Buffer | string): void {
    const full = this.resolve(rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }

  read(rel: string): Buffer {
    return fs.readFileSync(this.resolve(rel));
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.resolve(rel));
  }

  removeProjectDir(projectId: number): void {
    fs.rmSync(this.resolve(path.posix.join('projects', String(projectId))), { recursive: true, force: true });
  }

  exportDir(projectId: number, stamp: string): string {
    return this.resolve(path.posix.join('exports', String(projectId), stamp));
  }
}
