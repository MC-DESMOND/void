// CONST.ts
export function toVoidUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/"); // "C:/Users/..."
  const encoded = normalized.replace(/^([A-Z]):/, "$1%3A"); // "C%3A/Users/..."
  return "void://" + encoded;
}