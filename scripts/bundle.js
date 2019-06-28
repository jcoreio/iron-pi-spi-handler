
const path = require('path')

const { copy, emptyDir, ensureDir } = require('fs-extra')
const { logger } = require('log4jcore')
const { spawn } = require('promisify-child-process')
const { bundle } = require('@jcoreio/tar-bundler')

const APP_NAME = 'iron-pi-spi-handler'

const rootDir = path.resolve(__dirname, '..')
const bundleDir = path.join(rootDir, 'build', 'bundle')
const appBundleDir = path.join(bundleDir, APP_NAME)
const distDir = path.join(rootDir, 'dist')

const log = logger('iron-pi-spi-handler:bundle')

async function run() {
  await emptyDir(bundleDir)
  await ensureDir(appBundleDir)
  log.info('copying assets...')
  for (const fileOrDir of ['lib', 'LICENSE', 'package.json', 'README.md', 'yarn.lock']) {
    await copy(path.join(rootDir, fileOrDir), path.join(appBundleDir, fileOrDir))
  }
  log.info('installing production dependencies...')
  await spawn('yarn', ['--production', '--frozen-lockfile'], {
    cwd: appBundleDir,
    stdio: 'inherit',
  })

  const { version } = require('../package.json')
  const archiveFile = `${APP_NAME}-v${version}.tar.bz2`
  const archiveFileRelative = `dist/${archiveFile}`

  log.info('creating dist dir...')
  await ensureDir(distDir)

  log.info(`generating ${archiveFileRelative}...`)
  await bundle({srcDir: bundleDir, destFile: path.join(distDir, archiveFile)})

  log.info(`successfully wrote ${archiveFileRelative}`)
}

run()
