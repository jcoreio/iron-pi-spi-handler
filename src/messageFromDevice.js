// @flow

import assert from 'assert'

import type {DetectedDevice, DeviceInputState} from '@jcoreio/iron-pi-ipc-codec'
import {deviceInputStatePayloadLen, MSG_FROM_DEVICE_INPUT_STATE, MSG_FROM_DEVICE_PREAMBLE, MESSAGE_FROM_DEVICE_OVERHEAD} from './spiProtocol'
import {calcChecksum} from "./checksum"

function decodeBits({buf, pos, count}: {buf: Buffer, pos: number, count: number}): Array<boolean> {
  const numBytes = Math.ceil(count / 8)
  let outIdx = 0
  const arr: Array<boolean> = []
  for (let byteIdx = 0; byteIdx < numBytes; ++byteIdx) {
    const byteVal = buf.readUInt8(pos + byteIdx)
    for (let bitIdx = 0; bitIdx < 8; ++bitIdx) {
      if (outIdx++ < count) {
        arr.push((byteVal & (1 << bitIdx)) !== 0)
      }
    }
  }
  return arr
}

export function decodeDeviceInputState({device, buf, detect}: {
  device: DetectedDevice,
  buf: Buffer,
  detect?: ?boolean,
}): DeviceInputState {
  const {address, model} = device
  // Discard one dummy byte
  buf = buf.slice(1)
  if (buf.length < MESSAGE_FROM_DEVICE_OVERHEAD)
    throw Error(`length is too short: got ${buf.length}, expected ${MESSAGE_FROM_DEVICE_OVERHEAD} or more`)
  const preamble = buf.readUInt8(0)
  assert.strictEqual(preamble, MSG_FROM_DEVICE_PREAMBLE, `preamble mismatch: got ${preamble}, expected ${MSG_FROM_DEVICE_PREAMBLE}`)
  const len = buf.readUInt16LE(1)
  const minLen = len + 4
  if (buf.length < minLen)
    throw Error(`message is truncated: got length ${buf.length}, expected ${minLen}`)

  if (!detect) {
    // Allow checksum mismatches if we're just trying to detect whether a device is present
    // Checksum calculation begins at byte 3
    const expectedXRC = calcChecksum(buf.slice(3, len + 3))
    const actualXRC = buf.readUInt8(len + 3)
    assert.strictEqual(actualXRC, expectedXRC, `xrc mismatch from device ${address}: got ${actualXRC}, expected ${expectedXRC}`)
  }

  const actualAddr = buf.readUInt8(3)
  assert.strictEqual(actualAddr, address, `device address mismatch: got ${actualAddr}, expected ${address}`)

  const expectedPayloadLen = deviceInputStatePayloadLen(model)
  if (len < expectedPayloadLen)
    throw Error(`payload is too short: got ${len}, expected ${expectedPayloadLen}`)

  const msg = buf.readUInt8(4)
  assert.strictEqual(msg, MSG_FROM_DEVICE_INPUT_STATE, `device input state message ID mismatch from ${address}: got ${msg}, expected ${MSG_FROM_DEVICE_INPUT_STATE}`)

  let pos = 5
  const numDigitalIOs = model.numDigitalInputs
  const numDigitalIOBytes = Math.ceil(numDigitalIOs / 8)

  const digitalInputs: Array<boolean> = decodeBits({buf, pos, count: numDigitalIOs})
  pos += numDigitalIOBytes
  const digitalOutputs: Array<boolean> = decodeBits({buf, pos, count: numDigitalIOs})
  pos += numDigitalIOBytes
  const digitalInputEventCounts: Array<number> = []
  for (let ioIdx = 0; ioIdx < numDigitalIOs; ++ioIdx) {
    digitalInputEventCounts.push(buf.readUInt8(pos++))
  }
  const analogInputs: Array<number> = []
  for (let inputIdx = 0; inputIdx < model.numAnalogInputs; ++inputIdx) {
    analogInputs.push(buf.readUInt16LE(pos))
    pos += 2
  }
  const inputState: DeviceInputState = {
    address,
    digitalInputs,
    digitalInputEventCounts,
    digitalOutputs,
    analogInputs,
  }
  if (model.hasConnectButton) {
    const connectButtonState = buf.readUInt8(pos)
    inputState.connectButtonPressed = (connectButtonState & 0x80) !== 0
    inputState.connectButtonEventCount = connectButtonState & 0x7F
  }
  return inputState
}
