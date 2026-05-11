export interface SolveImage {
  data: string; // base64 (no data URL prefix)
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}
