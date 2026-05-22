import { randomBytes } from "node:crypto";

const ADJECTIVES = ['rapid', 'silent', 'blue', 'wild', 'smart'];
const NOUNS = ['tunnel', 'bridge', 'socket', 'stream', 'proxy'];

function randomItem(values: string[]): string {
  // Use crypto.randomBytes for a cryptographically secure random index so that
  // subdomain generation is not predictable from the V8 PRNG seed.
  const idx = randomBytes(1)[0] % values.length;
  return values[idx];
}

export function generateSubdomain(): string {
  // 8 random hex bytes = 64 bits of entropy — sufficient for a public namespace.
  const suffix = randomBytes(8).toString("hex");
  return `${randomItem(ADJECTIVES)}-${randomItem(NOUNS)}-${suffix}`;
}
