declare module "turndown" {
  export interface TurndownServiceOptions {
    headingStyle?: string;
    hr?: string;
    bulletListMarker?: string;
    codeBlockStyle?: string;
    emDelimiter?: string;
  }

  export default class TurndownService {
    constructor(options?: TurndownServiceOptions);
    remove(filters: string[]): void;
    turndown(input: string): string;
  }
}
