// @flow

import type {IronPiDeviceModel} from './ipcCodec'

/**
 * 1 byte preamble
 * 2 byte length
 * 1 byte address
 * 1 byte XRC
 * -----
 * 5 bytes of overhead
 */
export const MESSAGE_FROM_DEVICE_OVERHEAD = 5

/**
 * Breakdown of message space:
 * ------
 * Message ID: 1 byte = constant of 1
 * Digital input states: Num digital IOs / 8
 * Digital output states: Num digital IOs / 8
 * Digital input counts: Num Digital IOs
 * Analog Input States: Num Analog Inputs * 2
 * Connect button state: 1 if button is present, 0 otherwise
 */
export function deviceInputStatePayloadLen(modelInfo: IronPiDeviceModel): number {
  const {numDigitalInputs, numDigitalOutputs, numAnalogInputs, hasConnectButton} = modelInfo
  return 1 + Math.ceil(numDigitalInputs / 8) + Math.ceil(numDigitalOutputs / 8) +
    numDigitalInputs + (numAnalogInputs * 2) + (hasConnectButton ? 1 : 0)
}

export function deviceSPITransactionRequiredLen(modelInfo: IronPiDeviceModel): number {
  return MESSAGE_FROM_DEVICE_OVERHEAD + 1 + deviceInputStatePayloadLen(modelInfo)
}

export const SPI_COLOR_GREEN = 1
export const SPI_COLOR_RED = 2
export const SPI_COLOR_YELLOW = 3

export const MSG_TO_DEVICE_PREAMBLE = 0x5C

export const MSG_TO_DEVICE_SYNC_REQUEST_INPUTS = 1
export const MSG_TO_DEVICE_SYNC_FLASH = 2

export const MSG_PER_DEVICE_PREAMBLE = 0x72
export const MSG_PER_DEVICE_SET_OUTPUTS = 1
export const MSG_PER_DEVICE_SET_LED = 2

export const MSG_FROM_DEVICE_PREAMBLE = 0x3C
export const MSG_FROM_DEVICE_INPUT_STATE = 1

