// Serverless request bodies cap around 4.5 MB, and a retina viewport read back
// as a full-size PNG data URL clears that on its own — the review would 413
// before it ever reached qwen-vl-max. Downscale to a JPEG instead: 1024 px is
// well past the detail the model needs to judge one object's proportions.
export const MAX_CAPTURE_PX = 1024

export function downscaleCanvas(source, maxPx = MAX_CAPTURE_PX, quality = 0.85) {
  const { width, height } = source
  const scale = Math.min(1, maxPx / Math.max(width, height))
  if (scale === 1) return source.toDataURL('image/jpeg', quality)
  const out = document.createElement('canvas')
  out.width = Math.round(width * scale)
  out.height = Math.round(height * scale)
  out.getContext('2d').drawImage(source, 0, 0, out.width, out.height)
  return out.toDataURL('image/jpeg', quality)
}
