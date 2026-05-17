import type { IncomingMessage } from "node:http";

export function extractSubdomain(hostHeader: string | undefined, rootDomain: string): string | null {
  if (!hostHeader) {
    return null;
  }

  const host = hostHeader.split(":")[0].trim().toLowerCase();

  if (host === rootDomain) {
    return null;
  }

  if (!host.endsWith(`.${rootDomain}`)) {
    return null;
  }

  const subdomain = host.slice(0, -(rootDomain.length + 1));
  return subdomain || null;
}

export function readRequestBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk) => {
      const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += normalized.length;
      if (totalBytes > maxBodyBytes) {
        reject(new Error(`Request body exceeds limit of ${maxBodyBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(normalized);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
