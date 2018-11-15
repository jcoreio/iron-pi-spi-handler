// @flow

import {flatten, forOwn, range} from 'lodash'
import {MessageServer as IPCMessageServer} from 'socket-ipc'
// $FlowFixMe: wiring-pi only installs on ARM / Linux
import wpi from 'wiring-pi'
import IronPiIPCCodec from '@jcoreio/iron-pi-ipc-codec'
import type {
  DetectedDevice,
  DeviceInputState,
  DeviceModel,
  DeviceOutputState,
  HardwareInfo,
  LEDCommand,
  MessageToDriver,
} from '@jcoreio/iron-pi-ipc-codec'

import {encodeDeviceOutputs, encodeLEDCommandPerDevice, encodeMessageToDevice} from './messageToDevices'
import type {MessagePerDeviceOpts} from './messageToDevices'
import {readSerialNumberAndAccessCode} from './readSerialNumber'
import {decodeDeviceInputState} from './messageFromDevice'
import {MODEL_INFO_CM8, MODEL_INFO_IO16, } from './modelInfo'
import {deviceSPITransactionRequiredLen} from './spiProtocol'

const codec = new IronPiIPCCodec()

const SPI_BAUD_RATE = 1000000 // 1MHz
// const IRQ_PIN = 34

const ALL_POSSIBLE_DEVICES: Array<DetectedDevice> = flatten([
  MODEL_INFO_CM8,
  range(4).map(() => MODEL_INFO_IO16)
]).map((model: DeviceModel, idx: number) => ({ address: idx + 1, model }))

const _modelsByAddress: Map<number, DetectedDevice> = new Map()
ALL_POSSIBLE_DEVICES.forEach((device: DetectedDevice) => _modelsByAddress.set(device.address, device))

const _ipcServer = new IPCMessageServer('/tmp/socket-iron-pi', { binary: true })

let _devicesListMessage: ?Buffer
let _detectedDevices: Array<DetectedDevice> = []

let _ledMessagesToDevices: Array<LEDCommand> = []
let _outputsToDevices: Array<DeviceOutputState> = []
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
  const perDeviceMessages: Array<MessagePerDeviceOpts> = _ledMessagesToDevices.map(encodeLEDCommandPerDevice)
  _ledMessagesToDevices = []

  forOwn(_outputsToDevices, (outputLevels: Array<boolean>, strAddress: string) => {
    const address = parseInt(strAddress)
    const device: ?DetectedDevice = _modelsByAddress.get(address)
    if (device) {
      perDeviceMessages.push(encodeDeviceOutputs({
        address,
        numOutputs: device.model.numDigitalOutputs,
        outputLevels,
      }))
    }
  })
  _outputsToDevices = []

  const devices: Array<DetectedDevice> = detect ? ALL_POSSIBLE_DEVICES : _detectedDevices
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

  const deviceInputStates: Array<DeviceInputState> = []
  if (requestInputStates) {
    for (let deviceIdx = 0; deviceIdx < devices.length; ++deviceIdx) {
      const device: DetectedDevice = devices[deviceIdx]
      const {address} = device
      const nextDevice: ?DetectedDevice = deviceIdx + 1 < devices.length ? devices[deviceIdx + 1] : null
      const deviceRequestMessage: Buffer = encodeMessageToDevice({
        curAddress: address,
        nextAddress: nextDevice ? nextDevice.address : 0,
        minLen: deviceSPITransactionRequiredLen(device.model),
      })

      const response: Buffer = await doSPITransaction(deviceRequestMessage)
      try {
        deviceInputStates.push(decodeDeviceInputState({device, buf: response, detect}))
      } catch (err) {
        if (!detect)
          console.error(`could not decode response from device ${address}: ${err.message}`)
      }
    }
  }

  if (detect) {
    _detectedDevices = ALL_POSSIBLE_DEVICES.filter(device =>
      deviceInputStates.find((state: DeviceInputState) => state.address === device.address))
    console.log(`detected devices:${_detectedDevices.map((device: DetectedDevice) => `\n  ${device.address}: ${device.model.name}`).join('')}`)
  } else if (deviceInputStates.length) {
    _ipcServer.send(codec.encodeDeviceInputStates({inputStates: deviceInputStates}))
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
  const hardwareInfo: HardwareInfo = {
    devices: _detectedDevices,
    serialNumber,
    accessCode,
  }
  return codec.encodeHardwareInfo(hardwareInfo)
}

function onIPCConnection(connection: Object) {
  if (_devicesListMessage)
    connection.send(_devicesListMessage)
}

let _flashCount = 0

function onIPCMessage(event: Object) {
  const buf: Buffer = event.data
  try {
    const msg: MessageToDriver = codec.decodeMessageToDriver(buf)
    const {setOutputs, setLEDs} = msg
    if (setOutputs) {
      _outputsToDevices = setOutputs.outputs
      _flashLEDs = ++_flashCount >= 10
      if (_flashLEDs)
        _flashCount = 0
      _requestInputStates = true
      serviceBusAsync()
    }
    if (setLEDs) {
      _ledMessagesToDevices = setLEDs.leds
      serviceBusAsync()
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
