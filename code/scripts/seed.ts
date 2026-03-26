import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { seedBundle } from "../src/lib/data/mock-data";

const target = resolve(process.cwd(), "docs", "seed-output.json");
writeFileSync(target, JSON.stringify(seedBundle, null, 2));
console.log(`Seed snapshot written to ${target}`);
