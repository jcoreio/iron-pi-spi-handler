// @flow

export function calcChecksum(buf: Buffer): number {
  let xrc = 0x39
  const len = buf.length
  for (let idx = 0; idx < len; ++idx) {
    xrc = xrc ^ buf.readUInt8(idx)
  }
  return xrc
}
