// @flow

import assert from 'assert'

export type IronPiDeviceModel = {
  model: string,
  version: string,
  numDigitalInputs: number,
  numDigitalOutputs: number,
  numAnalogInputs: number,
  hasConnectButton: boolean,
}

export type IronPiDetectedDevice = {
  address: number,
  info: IronPiDeviceModel,
}

export type IronPiStateFromDevice = {
  address: number,
  digitalInputs: Array<boolean>,
  digitalInputEventCounts: Array<number>,
  digitalOutputs: Array<boolean>,
  analogInputs: Array<number>,
  connectButtonPressed?: boolean,
  connectButtonEventCount?: number,
}

export type IronPiHardwareInfo = {
  devices: Array<IronPiDetectedDevice>,
  serialNumber: string,
  accessCode: string,
}

export type OutputStatesMap = {
  [address: string]: Array<boolean>,
}

export type SetAllOutputsMessage = {
  outputs: OutputStatesMap,
  requestInputStates?: ?boolean,
  flashLEDs?: ?boolean,
}

export type LEDMessage = {
  address: number,
  colors: string, // e.g. 'gg' or 'ggrr'
  onTime: number,
  offTime: number,
  idleTime: number,
}

export const IPC_PROTO_VERSION = 1

export const IPC_SOCKET_PATH = '/tmp/socket-iron-pi'

// Messages from the SPI handler to clients
export const IPC_MSG_DEVICES_LIST = 1

// Messages from clients to the SPI handler
export const IPC_MSG_SET_ALL_OUTPUTS = 20
export const IPC_MSG_SET_LEDS = 21

export const IPC_MESSAGE_TO_DEVICE_PREAMBLE = 0xA3 // preamble for a single messge to a device

const PREAMBLE_BOOL_ARRAY = 0x72
const PREAMBLE_NUMBER_ARRAY = 0x5C

export const IPC_MESSAGE_OVERHEAD = 2


export function encodeJSON({msg, payload}: {msg: number, payload: any}): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(payload))
  const buf = Buffer.alloc(jsonBuf.length + IPC_MESSAGE_OVERHEAD)
  writeVersionAndMsg(buf, msg)
  jsonBuf.copy(buf, IPC_MESSAGE_OVERHEAD)
  return buf
}

export function decodeJSON(buf: Buffer): {msg: number, payload: any} {
  const msg = readVersionAndMsg(buf)
  const payload = JSON.parse(buf.slice(IPC_MESSAGE_OVERHEAD).toString())
  return {msg, payload}
}

export function encodeBoolArray(arr: Array<boolean>): Buffer {
  const buf = Buffer.alloc(arr.length + 3)
  buf.writeUInt8(PREAMBLE_BOOL_ARRAY, 0)
  buf.writeUInt16LE(arr.length, 1)
  let pos = 3
  for (const value of arr) {
    buf.writeUInt8(value ? 1 : 0, pos++)
  }
  return buf
}

export function decodeBoolArray(buf: Buffer, pos: number = 0): {arr: Array<boolean>, pos: number} {
  const preamble = buf.readUInt8(pos++)
  let count = buf.readUInt16LE(pos)
  pos += 2
  assert.strictEqual(preamble, PREAMBLE_BOOL_ARRAY, `unexpected bool array preamble: ${preamble}`)
  const arr: Array<boolean> = []
  while (count-- > 0) {
    arr.push(buf.readUInt8(pos++) !== 0)
  }
  return {arr, pos}
}

export function encodeFloatArray(arr: Array<number>): Buffer {
  const buf = Buffer.alloc(arr.length * 4 + 3)
  buf.writeUInt8(PREAMBLE_NUMBER_ARRAY, 0)
  buf.writeUInt16LE(arr.length, 1)
  let pos = 3
  for (const value of arr) {
    buf.writeFloatLE(value, pos)
    pos += 4
  }
  return buf
}

export function decodeFloatArray(buf: Buffer, pos: number = 0): {arr: Array<number>, pos: number} {
  const preamble = buf.readUInt8(pos++)
  let count = buf.readUInt16LE(pos)
  pos += 2
  assert.strictEqual(preamble, PREAMBLE_NUMBER_ARRAY, `unexpected number array preamble: ${preamble}`)
  const arr: Array<number> = []
  while (count-- > 0) {
    arr.push(buf.readFloatLE(pos))
    pos += 4
  }
  return {arr, pos}
}

export function encodeSetAllOutputs(setAllOutputsMessage: SetAllOutputsMessage): Buffer {
  const {outputs, requestInputStates, flashLEDs} = setAllOutputsMessage
  const addresses = Object.keys(outputs)
  const buffers: Array<Buffer> = addresses.map((addr: string) => encodeBoolArray(outputs[addr]))
  const requiredLen = buffers.reduce((sum: number, cur: Buffer) => sum + cur.length + 1, IPC_MESSAGE_OVERHEAD + 3)
  const buf = Buffer.alloc(requiredLen)
  writeVersionAndMsg(buf, IPC_MSG_SET_ALL_OUTPUTS)
  let pos = IPC_MESSAGE_OVERHEAD
  buf.writeUInt8(toInt(requestInputStates), pos++)
  buf.writeUInt8(toInt(flashLEDs), pos++)
  buf.writeUInt8(addresses.length, pos++)
  for (let idx = 0; idx < addresses.length; ++idx) {
    buf.writeUInt8(Number(addresses[idx]), pos++)
    buffers[idx].copy(buf, pos)
    pos += buffers[idx].length
  }
  return buf
}

export function decodeSetAllOutputs(buf: Buffer): SetAllOutputsMessage {
  const outputs: OutputStatesMap = {}
  const msg = readVersionAndMsg(buf)
  assert.strictEqual(msg, IPC_MSG_SET_ALL_OUTPUTS, `unexpected message ID for set all outputs message: got ${msg}, expected ${IPC_MSG_SET_ALL_OUTPUTS}`)
  let pos = IPC_MESSAGE_OVERHEAD
  const requestInputStates = !!buf.readUInt8(pos++)
  const flashLEDs = !!buf.readUInt8(pos++)
  let count = buf.readUInt8(pos++)
  while (count-- > 0) {
    const address = buf.readUInt8(pos++)
    const {arr, pos: newPos} = decodeBoolArray(buf, pos)
    pos = newPos
    outputs[address.toString()] = arr
  }
  return {outputs, requestInputStates, flashLEDs}
}

export function encodeSetLEDMessages(ledMessages: Array<LEDMessage>): Buffer {
  return encodeJSON({msg: IPC_MSG_SET_LEDS, payload: ledMessages})
}

export function decodeSetLEDMessages(buf: Buffer): Array<LEDMessage> {
  const {msg, payload} = decodeJSON(buf)
  assert.strictEqual(msg, IPC_MSG_SET_LEDS, `unexpected message in decodeLEDMessages: got ${msg}, expected ${IPC_MSG_SET_LEDS}`)
  return payload
}

function toInt(value: any): number {
  return value ? 1 : 0
}

function writeVersionAndMsg(buf: Buffer, msg: number) {
  buf.writeUInt8(IPC_PROTO_VERSION, 0)
  buf.writeUInt8(msg, 1)
}

function readVersionAndMsg(buf: Buffer): number {
  const version = buf.readUInt8(0)
  const msg = buf.readUInt8(1)
  assert.strictEqual(version, IPC_PROTO_VERSION, `version mismatch: got ${version}, expected ${IPC_PROTO_VERSION}`)
  return msg
}
