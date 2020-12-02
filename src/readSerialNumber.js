// @flow

import assert from 'assert'
// $FlowFixMe: @jcoreio/i2c does not install on Windows or Mac OS
import I2C from '@jcoreio/i2c'

export const SERIAL_NUMBER_LEN = 6
export const SERIAL_NUMBER_TXN_LEN = SERIAL_NUMBER_LEN + 2
export const ACCESS_CODE_LEN = 8
export const ACCESS_CODE_TXN_LEN = ACCESS_CODE_LEN + 2

export const SERIAL_NUMBER_OFFSET = 0
export const SERIAL_NUMBER_PREAMBLE = 0xa9

export const ACCESS_CODE_OFFSET = 32
export const ACCESS_CODE_PREAMBLE = 0x7c

const pause = () => new Promise(resolve => setTimeout(resolve, 10))

export type SerialNumberAndAccessCode = {
  serialNumber: string,
  accessCode: string,
}

export async function readSerialNumberAndAccessCode(): Promise<SerialNumberAndAccessCode> {
  const i2c: I2C = new I2C({ device: '/dev/i2c-1', address: 0x50 })

  const serialNumberResponse = await i2c.read(
      SERIAL_NUMBER_OFFSET,
      SERIAL_NUMBER_TXN_LEN
  )

  const serialNumberPreamble = serialNumberResponse[0]
  const serialNumberLength = serialNumberResponse[1]
  const serialNumber = serialNumberResponse.slice(2).toString()


  await pause()

  const accessCodeResponse = await i2c.read(
      ACCESS_CODE_OFFSET,
      ACCESS_CODE_TXN_LEN
  )

  const accessCodePreamble = accessCodeResponse[0]
  const accessCodeLength = accessCodeResponse[1]
  const accessCode = accessCodeResponse.slice(2).toString()

  assert.strictEqual(
      serialNumberPreamble,
      SERIAL_NUMBER_PREAMBLE,
      'Device ID preamble did not match'
  )
  assert.strictEqual(
      serialNumberLength,
      SERIAL_NUMBER_LEN,
      'Device ID length did not match'
  )

  assert.strictEqual(
      accessCodePreamble,
      ACCESS_CODE_PREAMBLE,
      'Access code preamble did not match'
  )
  assert.strictEqual(
      accessCodeLength,
      ACCESS_CODE_LEN,
      'Access code length did not match'
  )

  // eslint-disable-next-line no-console
  console.log(`Serial Number: ${serialNumber} Access Code: ${accessCode}`)
  return { serialNumber, accessCode }
}
