/**
 * On-demand compression settings (the seed-time artifact uses brotli quality 11 instead).
 * Measured on a 1.6 MB JSON response: brotli q5 takes 44 ms for < 1 % smaller output than q4 (21 ms).
 */
export const DYNAMIC_BROTLI_QUALITY = 4;
export const DYNAMIC_GZIP_LEVEL = 6;
