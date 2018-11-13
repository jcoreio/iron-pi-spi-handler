// @flow

/**
 * Messages addressed to a single device. One SPI transaction can contain many of these.
 */
import {calcChecksum} from './checksum'
import type {LEDMessage} from './ipcCodec'
import {
  MSG_PER_DEVICE_PREAMBLE,
  MSG_PER_DEVICE_SET_LED,
  MSG_PER_DEVICE_SET_OUTPUTS, MSG_TO_DEVICE_PREAMBLE, MSG_TO_DEVICE_SYNC_FLASH, MSG_TO_DEVICE_SYNC_REQUEST_INPUTS,
  SPI_COLOR_GREEN,
  SPI_COLOR_RED,
  SPI_COLOR_YELLOW
} from './spiProtocol'

export type MessagePerDeviceOpts = {
  address: number,
  cmd: number,
  payload?: ?Buffer,
}

/**
 * Message sent over the SPI bus to all devices
 * Format:
 *   Preamble: 1 byte = 0x72
 *   Device address: 1 byte
 *   Command: 1 byte
 *   Payload: 0 to n bytes
 */
export type MessageToDevicesOpts = {
  curAddress: number,
  nextAddress: number,
  requestInputStates?: ?boolean,
  flashLEDs?: ?boolean,
  perDeviceMessages?: ?Array<MessagePerDeviceOpts>,
  minLen?: ?number, // optionally force a minimum buffer size. Useful for duplex read / write SPI transactions where read size = write size
}

export function encodeDeviceOutputs({address, numOutputs, outputLevels}: {
  address: number,
  numOutputs: number,
  outputLevels: Array<boolean>,
}): MessagePerDeviceOpts {
  const numBytes = Math.ceil(numOutputs / 8)
  const buf = Buffer.alloc(numBytes)

  let outputIdx = 0
  for (let byteIdx = 0; byteIdx < numBytes; ++byteIdx) {
    let byteValue = 0
    for (let bitIdx = 0; bitIdx < 8; ++bitIdx) {
      if (outputIdx < numOutputs && outputLevels[outputIdx])
        byteValue |= (1 << bitIdx)
      ++outputIdx
    }
    buf.writeUInt8(byteValue, byteIdx)
  }
  return {address, cmd: MSG_PER_DEVICE_SET_OUTPUTS, payload: buf}
}

const encodeColor = (color: string) => {
  switch (color) {
  case 'r':
    return SPI_COLOR_RED // red
  case 'y':
  case 'o':
    return SPI_COLOR_YELLOW // green | red = yellow / orange
  default:
    return SPI_COLOR_GREEN // green
  }
}

export function encodeLEDMessagePerDevice(ledMessage: LEDMessage): MessagePerDeviceOpts {
  const {address, colors, onTime, offTime, idleTime} = ledMessage
  const colorsFinal = colors.toLowerCase()
  let curColorIdx = -1
  let colorsArr = []
  let countsArr = []
  let prevColor = null
  for (let pos = 0; pos < colorsFinal.length; ++pos) {
    let thisColor = encodeColor(colorsFinal.charAt(pos))
    if (thisColor !== prevColor) {
      if (++curColorIdx >= 2)
        break // too many colors
    }
    colorsArr[curColorIdx] = thisColor
    countsArr[curColorIdx] = (countsArr[curColorIdx] || 0) + 1
    prevColor = thisColor
  }

  const buf = Buffer.alloc(12)
  let pos = 0
  buf.writeUInt8(colorsArr[0] || 0, pos++)
  buf.writeUInt8(countsArr[0] || 0, pos++)
  buf.writeUInt8(colorsArr[1] || 0, pos++)
  buf.writeUInt8(countsArr[1] || 0, pos++)
  buf.writeUInt16LE(onTime, pos)
  pos += 2
  buf.writeUInt16LE(offTime, pos)
  pos += 2
  buf.writeUInt32LE(idleTime, pos)
  return {address, cmd: MSG_PER_DEVICE_SET_LED, payload: buf}
}


function encodeMessagePerDevice(opts: MessagePerDeviceOpts): Buffer {
  const {address, cmd, payload} = opts
  const payloadLen = payload ? payload.length : 0
  const buf: Buffer = Buffer.alloc(4 + payloadLen)
  let pos = 0
  buf.writeUInt8(MSG_PER_DEVICE_PREAMBLE, pos++) // preamble
  buf.writeUInt8(address, pos++)
  buf.writeUInt8(cmd, pos++)
  buf.writeUInt8(payloadLen, pos++)
  if (payload)
    payload.copy(buf, pos)
  return buf
}

/**
 * Format:
 *   Preamble: 1 byte = 0x5C
 *   Length: 2 bytes
 *   Cur device addr: 1 byte
 *   Next device addr: 1 byte
 *   Sync command: 1 byte
 *   Message count: 1 byte
 *   Messages per device: 0 to n bytes
 *   XRC: 1 byte
 * @param opts
 */
export function encodeMessageToDevice(opts: MessageToDevicesOpts): Buffer {
  const {curAddress, nextAddress, requestInputStates, flashLEDs, perDeviceMessages, minLen} = opts
  const perDevicesMessagesFinal: Array<MessagePerDeviceOpts> = perDeviceMessages || []
  const perDeviceMessageBuffers = perDevicesMessagesFinal.map(encodeMessagePerDevice)
  const messagesPerDeviceLen = perDeviceMessageBuffers.reduce((sum: number, cur: Buffer) => sum + cur.length, 0)
  const buf = Buffer.alloc(Math.max(messagesPerDeviceLen + 8, minLen || 0)) // Overhead includes preamble, 2 byte length, cur address, next address, sync command, message count, and XRC
  let pos = 0
  buf.writeUInt8(MSG_TO_DEVICE_PREAMBLE, pos++)
  buf.writeUInt16LE(messagesPerDeviceLen + 4, pos) // There are 4 bytes included in the length before the messages per device payload
  pos += 2
  buf.writeUInt8(curAddress, pos++)
  buf.writeUInt8(nextAddress, pos++)
  const syncCommand = (requestInputStates ? MSG_TO_DEVICE_SYNC_REQUEST_INPUTS : 0) |
    (flashLEDs ? MSG_TO_DEVICE_SYNC_FLASH : 0)
  buf.writeUInt8(syncCommand, pos++)
  buf.writeUInt8(perDevicesMessagesFinal.length, pos++)
  for (const perDeviceMessageBuffer: Buffer of perDeviceMessageBuffers) {
    perDeviceMessageBuffer.copy(buf, pos)
    pos += perDeviceMessageBuffer.length
  }
  const xrc = calcChecksum(buf.slice(3, pos))
  buf.writeUInt8(xrc, pos)
  return buf
}
