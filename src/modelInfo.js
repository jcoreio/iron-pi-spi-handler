// @flow

import type {DeviceModel} from '@jcoreio/iron-pi-ipc-codec'

export const MODEL_INFO_CM8: DeviceModel = {
  name: 'iron-pi-cm8',
  version: '1.0.0',
  numDigitalInputs: 8,
  numDigitalOutputs: 8,
  numAnalogInputs: 4,
  hasConnectButton: true,
}

export const MODEL_INFO_IO16: DeviceModel = {
  name: 'iron-pi-io16',
  version: '1.0.0',
  numDigitalInputs: 16,
  numDigitalOutputs: 16,
  numAnalogInputs: 8,
  hasConnectButton: false,
}
