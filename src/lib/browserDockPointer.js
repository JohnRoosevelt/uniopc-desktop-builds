/** Map a pointer in the dock viewport to the fitted image content (object-fit: contain). */
export function mapBrowserDockPointer(clientX, clientY, rect, imageWidth, imageHeight) {
  const viewportWidth = Number(rect?.width)
  const viewportHeight = Number(rect?.height)
  const width = Number(imageWidth)
  const height = Number(imageHeight)
  if (![clientX, clientY, viewportWidth, viewportHeight, width, height].every(Number.isFinite)
    || viewportWidth <= 0 || viewportHeight <= 0 || width <= 0 || height <= 0) return null

  const imageRatio = width / height
  const viewportRatio = viewportWidth / viewportHeight
  const contentWidth = viewportRatio > imageRatio ? viewportHeight * imageRatio : viewportWidth
  const contentHeight = viewportRatio > imageRatio ? viewportHeight : viewportWidth / imageRatio
  const contentLeft = (viewportWidth - contentWidth) / 2
  const contentTop = (viewportHeight - contentHeight) / 2
  const localX = clientX - rect.left - contentLeft
  const localY = clientY - rect.top - contentTop
  if (localX < 0 || localY < 0 || localX > contentWidth || localY > contentHeight) return null
  return { x: localX / contentWidth, y: localY / contentHeight }
}
