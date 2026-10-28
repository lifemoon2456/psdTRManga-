declare module "fontkit" {
  /** Browser build accepts a Uint8Array containing a font file. */
  export function create(buffer: Uint8Array): unknown;
}
