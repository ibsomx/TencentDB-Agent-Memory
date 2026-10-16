import { GitSourceFetcher } from "./git-fetcher.js";
import { LocalSourceFetcher } from "./local-fetcher.js";
import type { ISourceFetcher, SourceType } from "./types.js";
import { isAbsolute } from "node:path";

export class SourceFetcherRegistry {
  private readonly fetchers = new Map<SourceType, ISourceFetcher>();

  constructor() {
    this.register(new GitSourceFetcher());
    this.register(new LocalSourceFetcher());
  }

  register(fetcher: ISourceFetcher): void {
    this.fetchers.set(fetcher.supportedType, fetcher);
  }

  resolve(sourceUrl: string): ISourceFetcher {
    const type = this.detectType(sourceUrl);
    const fetcher = this.fetchers.get(type);
    if (!fetcher) {
      throw new Error(`unsupported source type: ${type} (${sourceUrl})`);
    }
    return fetcher;
  }

  private detectType(url: string): SourceType {
    if (
      url.startsWith("git@") ||
      url.startsWith("ssh://") ||
      url.startsWith("https://") ||
      url.startsWith("http://")
    ) {
      return "git";
    }
    if (/^file:/i.test(url) || isAbsolute(url) || /^\.{1,2}[\\/]/.test(url)) {
      return "local";
    }
    if (url.startsWith("ftp://")) return "ftp";
    return "git";
  }
}
