import { createHash } from "node:crypto";

/** Pass `source` through unchanged while computing its SHA-256 and length. */
export function hashingStream(source: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  digest: () => string;
  size: () => number;
} {
  const hash = createHash("sha256");
  let size = 0;
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        size += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  let hex: string | null = null;
  return { stream, digest: () => (hex ??= hash.digest("hex")), size: () => size };
}
