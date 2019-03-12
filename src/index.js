// @flow

import {compact, flatten, isEqual, range} from 'lodash'
import logger from 'log4jcore'
import {MessageServer as IPCMessageServer} from 'socket-ipc'
// $FlowFixMe: wiring-pi only installs on ARM / Linux
import wpi from 'wiring-pi'
import IronPiIPCCodec, {UNIX_SOCKET_PATH} from '@jcoreio/iron-pi-ipc-codec'
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

const log = logger('iron-pi-spi-handler')

const codec = new IronPiIPCCodec()

const MESSAGE_MIN_GAP = 3 // minimum time, in milliseconds, between the end of one SPI transaction and the beginning of the next one

const POLL_INTERVAL = 100 // milliseconds

const SPI_BAUD_RATE = 1000000 // 1MHz
// const IRQ_PIN = 34

const allPossibleDevices: Array<DeviceModel> = flatten([
  MODEL_INFO_CM8,
  range(4).map(() => MODEL_INFO_IO16)
])
// Loop through devices to calculate the I/O offset of each device
const ALL_POSSIBLE_DEVICES: Array<DetectedDevice> = []
let ioOffset = 0
for (let deviceIdx = 0; deviceIdx < allPossibleDevices.length; ++deviceIdx) {
  const model: DeviceModel = allPossibleDevices[deviceIdx]
  ALL_POSSIBLE_DEVICES.push({
    address: deviceIdx + 1,
    ioOffset,
    model,
  })
  const {numAnalogInputs, numDigitalInputs, numDigitalOutputs} = model
  ioOffset += Math.max(numAnalogInputs, numDigitalInputs, numDigitalOutputs)
}

const _modelsByAddress: Map<number, DetectedDevice> = new Map()
ALL_POSSIBLE_DEVICES.forEach((device: DetectedDevice) => _modelsByAddress.set(device.address, device))

const _ipcServer = new IPCMessageServer(UNIX_SOCKET_PATH, { binary: true })

let _devicesListMessage: ?Buffer
let _detectedDevices: Array<DetectedDevice> = []

let _ledMessagesToDevices: Array<LEDCommand> = []
let _outputsToDevices: Map<number, DeviceOutputState> = new Map()
let _requestInputStates: boolean = false
let _flashLEDs: boolean = false

async function main(): Promise<void> {
  wpi.wiringPiSPISetup(0, SPI_BAUD_RATE)
  await serviceBus({detect: true})
  _devicesListMessage = await createDevicesListMessage()

  _ipcServer.on('message', onIPCMessage)
  _ipcServer.on('connection', onIPCConnection)
  _ipcServer.on('error', err => log.error('ipc server error:', err))
  _ipcServer.start()
  log.info('started message server')

  let flashCount = 0
  while (true) { // eslint-disable-line no-constant-condition
    const pollBegin = Date.now()
    if (++flashCount >= 20) { // blink once per second
      _flashLEDs = true
      flashCount = 0
    }
    _requestInputStates = true
    await serviceBusLoop()
    const elapsed = Date.now() - pollBegin
    const sleepTime = Math.max(POLL_INTERVAL - elapsed, 10)
    await new Promise(resolve => setTimeout(resolve, sleepTime))
  }
}

async function serviceBus(opts: {detect?: ?boolean} = {}): Promise<void> {
  const {detect} = opts

  const perDeviceMessages: Array<MessagePerDeviceOpts> = compact(_ledMessagesToDevices.map(encodeLEDCommandPerDevice))
  _ledMessagesToDevices = []

  for (const deviceOutputState: DeviceOutputState of _outputsToDevices.values()) {
    const {address, levels} = deviceOutputState
    const device: ?DetectedDevice = _modelsByAddress.get(address)
    if (device) {
      perDeviceMessages.push(encodeDeviceOutputs({
        address,
        numOutputs: device.model.numDigitalOutputs,
        outputLevels: levels
      }))
    }
  }

  const devices: Array<DetectedDevice> = detect ? ALL_POSSIBLE_DEVICES : _detectedDevices
  const requestInputStates = detect || _requestInputStates
  _requestInputStates = false

  const initialMessage: Buffer = encodeMessageToDevice({
    curAddress: 0,
    nextAddress: requestInputStates && devices.length ? devices[0].address : 0,
    requestInputStates,
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
          log.info(`could not decode response from device ${address}: ${err.message}\nresponse:`, response)
      }
    }
  }

  if (detect) {
    _detectedDevices = ALL_POSSIBLE_DEVICES.filter(device =>
      deviceInputStates.find((state: DeviceInputState) => state.address === device.address))
    log.info(`detected devices:${_detectedDevices.map((device: DetectedDevice) => `\n  ${device.address}: ${device.model.name}`).join('')}`)
  } else if (deviceInputStates.length) {
    _ipcServer.send(codec.encodeDeviceInputStates({inputStates: deviceInputStates}))
  }
}

let _lastMessageTime: number = 0

async function doSPITransaction(buf: Buffer): Promise<Buffer> {
  const elapsedSinceLastMessage = Date.now() - _lastMessageTime
  const waitTime = MESSAGE_MIN_GAP - elapsedSinceLastMessage
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
    .catch(err => log.error('caught error in ensureBusServiced:', err))
}

async function createDevicesListMessage(): Promise<Buffer> {
  let serialNumber, accessCode
  try {
    const result = await readSerialNumberAndAccessCode()
    serialNumber = result.serialNumber
    accessCode = result.accessCode
  } catch (err) {
    log.error("could not read hardware serial number and access code. Using empty serial number and access code of 'ABCDEFGH'")
    serialNumber = ''
    accessCode = 'ABCDEFGH'
  }

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

function onIPCMessage(event: {data: Buffer}) {
  const buf: Buffer = event.data
  try {
    const msg: MessageToDriver = codec.decodeMessageToDriver(buf)
    const {setOutputs, setLEDs} = msg
    if (setOutputs) {
      const {outputs} = setOutputs
      let anyOutputsChanged = false
      for (let deviceOutputs: DeviceOutputState of (outputs || [])) {
        if (!isEqual(deviceOutputs, _outputsToDevices.get(deviceOutputs.address))) {
          _outputsToDevices.set(deviceOutputs.address, deviceOutputs)
          anyOutputsChanged = true
        }
      }
      if (anyOutputsChanged)
        serviceBusAsync()
    }
    if (setLEDs) {
      _ledMessagesToDevices = setLEDs.leds
      serviceBusAsync()
    }
  } catch (err) {
    log.error('error handling IPC message:', err)
  }
}

main()
  .catch((err: any) => {
    log.error('unexpected error:', err)
    process.exit(1)
  })
