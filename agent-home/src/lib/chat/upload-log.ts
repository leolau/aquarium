/**
 * One log line per refused or failed upload: route, status, error code and
 * sizes/types only — never file contents, names, cookies or tokens.
 */
export interface UploadFailureInfo {
  fileSize?: number;
  fileType?: string;
}

function baseType(value: string | null | undefined): string {
  return (value ?? "").split(";")[0].trim().toLowerCase() || "-";
}

export async function logUploadFailure(
  route: string,
  request: Request,
  response: Response,
  info: UploadFailureInfo = {},
): Promise<void> {
  if (response.status < 400) return;
  let code = "-";
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    if (typeof body?.error === "string") code = body.error;
  } catch {
    // Not JSON: the status says enough.
  }
  const length = request.headers.get("content-length") ?? "-";
  console.warn(
    `[upload] ${route} failed status=${response.status} error=${code} ` +
      `content_length=${length} content_type=${baseType(request.headers.get("content-type"))} ` +
      `file_size=${info.fileSize ?? "-"} file_type=${baseType(info.fileType)}`,
  );
}
