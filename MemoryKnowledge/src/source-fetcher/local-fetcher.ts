import { copyLocalSource, validateLocalSource } from "./local-source-policy.js";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

export class LocalSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "local";

  validate(sourceUrl: string): void { validateLocalSource(sourceUrl); }

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
      copyLocalSource(sourceUrl, localPath);
      return { localPath, version: "local", sourceType: "local" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
      copyLocalSource(sourceUrl, localPath);
      return { localPath, version: "local", sourceType: "local" };
  }
}
