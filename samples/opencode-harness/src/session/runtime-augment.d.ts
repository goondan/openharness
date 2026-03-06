import "@goondan/openharness";

declare module "@goondan/openharness" {
  interface RuntimeContext {
    model: {
      provider: string;
      modelName: string;
    };
  }
}

export {};
