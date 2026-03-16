import * as path from "node:path";
import dotenv from "dotenv";

/**
 * Load .env file from the given workdir.
 * process.env values take precedence over .env file values (CONFIG-CONST-003).
 * Using override: false ensures existing process.env values are not overwritten.
 */
export function loadEnv(workdir: string): void {
  const envPath = path.join(workdir, ".env");
  dotenv.config({ path: envPath, override: false });
}
