const ADJECTIVES = ['rapid', 'silent', 'blue', 'wild', 'smart'];
const NOUNS = ['tunnel', 'bridge', 'socket', 'stream', 'proxy'];

function randomItem(values: string[]): string {
  return values[Math.floor(Math.random() * values.length)];
}

export function generateSubdomain(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${randomItem(ADJECTIVES)}-${randomItem(NOUNS)}-${suffix}`;
}
