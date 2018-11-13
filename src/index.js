// @flow

import assert from 'assert'

import {flatten, forOwn, range} from 'lodash'
import {MessageServer as IPCMessageServer} from 'socket-ipc'
// $FlowFixMe: wiring-pi only installs on ARM / Linux
import wpi from 'wiring-pi'
import {
  encodeJSON,
  IPC_MSG_DEVICES_LIST,
  IPC_MESSAGE_OVERHEAD,
  IPC_PROTO_VERSION,
  IPC_SOCKET_PATH,
  IPC_MSG_SET_ALL_OUTPUTS, IPC_MSG_SET_LEDS, decodeSetLEDMessages, decodeSetAllOutputs
} from './ipcCodec'
import type {
  IronPiDetectedDevice,
  IronPiHardwareInfo,
  IronPiDeviceModel,
  LEDMessage,
  OutputStatesMap,
  IronPiStateFromDevice
} from './ipcCodec'

import {encodeDeviceOutputs, encodeLEDMessagePerDevice, encodeMessageToDevice} from './messageToDevices'
import type {MessagePerDeviceOpts} from './messageToDevices'
import {readSerialNumberAndAccessCode} from './readSerialNumber'
import {decodeDeviceInputState} from './messageFromDevice'
import {MODEL_INFO_CM8, MODEL_INFO_IO16, } from './modelInfo'
import {deviceSPITransactionRequiredLen} from './spiProtocol'

const SPI_BAUD_RATE = 1000000 // 1MHz
// const IRQ_PIN = 34

const ALL_POSSIBLE_DEVICES: Array<IronPiDetectedDevice> = flatten([
  MODEL_INFO_CM8,
  range(4).map(() => MODEL_INFO_IO16)
]).map((info: IronPiDeviceModel, idx: number) => ({ address: idx + 1, info }))

const _modelsByAddress: Map<number, IronPiDetectedDevice> = new Map()
ALL_POSSIBLE_DEVICES.forEach((device: IronPiDetectedDevice) => _modelsByAddress.set(device.address, device))

const _ipcServer = new IPCMessageServer(IPC_SOCKET_PATH, { binary: true })

let _devicesListMessage

let _detectedDevices: Array<IronPiDetectedDevice> = []

let _ledMessagesToDevices: Array<LEDMessage> = []
let _outputsToDevices: OutputStatesMap = {}
let _requestInputStates: boolean = false
let _flashLEDs: boolean = false

async function main(): Promise<void> {
  wpi.wiringPiSPISetup(0, SPI_BAUD_RATE)
  await serviceBus({detect: true})
  _devicesListMessage = await createDevicesListMessage()

  _ipcServer.on('message', onIPCMessage)
  _ipcServer.on('connection', onIPCConnection)
  _ipcServer.on('error', err => console.error('ipc server error:', err))
  _ipcServer.start()
  console.log('started message server')
}

async function serviceBus(opts: {detect?: ?boolean} = {}): Promise<void> {
  const {detect} = opts
  const perDeviceMessages: Array<MessagePerDeviceOpts> = _ledMessagesToDevices.map(encodeLEDMessagePerDevice)
  _ledMessagesToDevices = []

  forOwn(_outputsToDevices, (outputLevels: Array<boolean>, strAddress: string) => {
    const address = parseInt(strAddress)
    const device: ?IronPiDetectedDevice = _modelsByAddress.get(address)
    if (device) {
      perDeviceMessages.push(encodeDeviceOutputs({
        address,
        numOutputs: device.info.numDigitalOutputs,
        outputLevels,
      }))
    }
  })
  _outputsToDevices = {}

  const devices: Array<IronPiDetectedDevice> = detect ? ALL_POSSIBLE_DEVICES : _detectedDevices
  const requestInputStates = detect || _requestInputStates
  _requestInputStates = false

  const initialMessage: Buffer = encodeMessageToDevice({
    curAddress: 0,
    nextAddress: requestInputStates && devices.length ? devices[0].address : 0,
    requestInputStates: detect || _requestInputStates,
    flashLEDs: _flashLEDs,
    perDeviceMessages,
  })
  _flashLEDs = false

  await doSPITransaction(initialMessage)

  const statesFromDevices: Array<IronPiStateFromDevice> = []
  if (requestInputStates) {
    for (let deviceIdx = 0; deviceIdx < devices.length; ++deviceIdx) {
      const device: IronPiDetectedDevice = devices[deviceIdx]
      const {address} = device
      const nextDevice: ?IronPiDetectedDevice = deviceIdx + 1 < devices.length ? devices[deviceIdx + 1] : null
      const deviceRequestMessage: Buffer = encodeMessageToDevice({
        curAddress: address,
        nextAddress: nextDevice ? nextDevice.address : 0,
        minLen: deviceSPITransactionRequiredLen(device.info),
      })

      const response: Buffer = await doSPITransaction(deviceRequestMessage)
      try {
        statesFromDevices.push(decodeDeviceInputState({device, buf: response}))
      } catch (err) {
        console.error(`could not decode response from device ${address}: ${err.message}`)
      }
    }
  }

  if (detect) {
    _detectedDevices = ALL_POSSIBLE_DEVICES.filter(device =>
      statesFromDevices.find((state: IronPiStateFromDevice) => state.address === device.address))
    console.log(`detected devices:${_detectedDevices.map((device: IronPiDetectedDevice) => `\n  ${device.address}: ${device.info.model}`).join('')}`)
  } else if (statesFromDevices.length) {
    // _ipcServer.send()
  }
}

let _lastMessageTime: number = 0

async function doSPITransaction(buf: Buffer): Promise<Buffer> {
  const elapsedSinceLastMessage = Date.now() - _lastMessageTime
  const waitTime = 2 - elapsedSinceLastMessage
  if (waitTime > 0)
    await new Promise(resolve => setTimeout(resolve, waitTime))

  wpi.wiringPiSPIDataRW(0, buf)

  _lastMessageTime = Date.now()
  return buf
}

let _serviceBusRepeat = false
let _serviceBusInProgress = false

async function serviceBusLoop(): Promise<void> {
  if (_serviceBusInProgress) {
    _serviceBusRepeat = true
    return
  }
  try {
    _serviceBusInProgress = true
    let sanityCount = 10
    do {
      _serviceBusRepeat = false
      if (--sanityCount <= 0)
        throw Error('infinite loop in serviceBusLoop')
      await serviceBus()
    } while (_serviceBusRepeat)
  } finally {
    _serviceBusInProgress = false
  }
}

function serviceBusAsync() {
  serviceBusLoop()
    .catch(err => console.error('caught error in ensureBusServiced:', err))
}

async function createDevicesListMessage(): Promise<Buffer> {
  const { serialNumber, accessCode } = await readSerialNumberAndAccessCode()
  const hardwareInfo: IronPiHardwareInfo = {
    devices: _detectedDevices,
    serialNumber,
    accessCode,
  }
  return encodeJSON({msg: IPC_MSG_DEVICES_LIST, payload: hardwareInfo})
}

function onIPCConnection(connection: Object) {
  if (_devicesListMessage)
    connection.send(_devicesListMessage)
}

function onIPCMessage(event: Object) {
  // console.log('got ipc message')
  const buf: Buffer = event.data
  try {
    assert(buf.length >= IPC_MESSAGE_OVERHEAD, 'message is too short')
    let pos = 0
    const version = buf.readUInt8(pos++)
    const msg = buf.readUInt8(pos++)
    assert.strictEqual(version, IPC_PROTO_VERSION, `unexpected IPC protocol version: got ${version}, expected ${IPC_PROTO_VERSION}`)
    switch (msg) {
    case IPC_MSG_SET_ALL_OUTPUTS: {
      const {outputs, requestInputStates, flashLEDs} = decodeSetAllOutputs(buf)
      _outputsToDevices = outputs
      if (requestInputStates) _requestInputStates = true
      if (flashLEDs) _flashLEDs = true
      serviceBusAsync()
    } break
    case IPC_MSG_SET_LEDS:
      _ledMessagesToDevices = decodeSetLEDMessages(buf)
      serviceBusAsync()
      break
    default:
      throw Error(`unknown IPC message: ${msg}`)
    }
  } catch (err) {
    console.error('error handling IPC message:', err)
  }
}

main()
  .catch((err: any) => {
    console.error('unexpected error:', err)
    process.exit(1)
  })
