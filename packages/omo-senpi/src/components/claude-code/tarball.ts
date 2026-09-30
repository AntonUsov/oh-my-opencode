import { gunzipSync } from "node:zlib"

const BLOCK = 512

export class TarballEntryMissingError extends Error {
  constructor(readonly entryName: string) {
    super(`the package tarball has no ${entryName}`)
    this.name = "TarballEntryMissingError"
  }
}

function field(header: Uint8Array, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length)
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end))
}

function octal(header: Uint8Array, offset: number, length: number): number {
  const text = field(header, offset, length).trim()
  return text.length === 0 ? 0 : Number.parseInt(text, 8)
}

function entryPath(header: Uint8Array): string {
  const name = field(header, 0, 100)
  const prefix = field(header, 345, 155)
  return prefix.length > 0 ? `${prefix}/${name}` : name
}

export function extractTarballEntry(gzipped: Uint8Array, entryName: string): Uint8Array {
  const tar = gunzipSync(gzipped)
  let offset = 0
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + BLOCK
    if ((type === "0" || type === "\0") && entryPath(header) === entryName) {
      return tar.subarray(dataStart, dataStart + size)
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }
  throw new TarballEntryMissingError(entryName)
}
