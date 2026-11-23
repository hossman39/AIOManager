import { readFile } from 'node:fs/promises'
import { PassThrough, Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'
import { fileURLToPath } from 'node:url'
import { decodePNGFromStream, encodePNGToStream, make, registerFont } from 'pureimage'

const font = registerFont(
  fileURLToPath(new URL('../assets/BarlowCondensed-SemiBold.ttf', import.meta.url)),
  'BarlowCondensed'
)

export async function createNoticePoster() {
  const original = await readFile(new URL('../assets/membership-expired.png', import.meta.url))
  let template
  const cache = new Map()

  async function render(handle) {
    font.loadSync()
    template ??= decodePNGFromStream(Readable.from([original]))
    const background = await template
    const image = make(background.width, background.height)
    image.data.set(background.data)
    const ctx = image.getContext('2d')
    const center = image.width / 2
    ctx.fillStyle = '#101113'
    ctx.fillRect(0, 380, image.width, 144)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#f9f9f9'
    ctx.font = '34pt BarlowCondensed'
    ctx.fillText('Renew on Telegram', center, 431)
    ctx.fillStyle = '#f2c20e'
    ctx.font = '56pt BarlowCondensed'
    const size = Math.min(56, Math.floor((56 * (image.width - 52)) / ctx.measureText(handle).width))
    ctx.font = `${size}pt BarlowCondensed`
    ctx.fillText(handle, center, 496)
    const png = new PassThrough()
    const [bytes] = await Promise.all([buffer(png), encodePNGToStream(image, png)])
    return bytes
  }

  return (handle) => {
    if (!handle) return original
    if (!cache.has(handle)) {
      if (cache.size >= 16) cache.delete(cache.keys().next().value)
      const pending = render(handle).catch((error) => {
        if (cache.get(handle) === pending) cache.delete(handle)
        throw error
      })
      cache.set(handle, pending)
    }
    return cache.get(handle)
  }
}
