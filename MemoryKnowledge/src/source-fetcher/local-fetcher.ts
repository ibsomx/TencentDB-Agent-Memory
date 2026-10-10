import fs from "fs";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

export class LocalSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "local";

  validate(sourceUrl: string): void {}

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
      let path = sourceUrl;
      if (path.startsWith("file:///")) path = path.slice(8);
      path = decodeURIComponent(path);
      fs.cpSync(path, localPath, { recursive: true });
      return { localPath, version: "local", sourceType: "local" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
      let path = sourceUrl;
      if (path.startsWith("file:///")) path = path.slice(8);
      path = decodeURIComponent(path);
      fs.rmSync(localPath, { recursive: true, force: true });
      fs.cpSync(path, localPath, { recursive: true });
      return { localPath, version: "local", sourceType: "local" };
  }
}
