import AppKit
// Platform icon layout: preserve the brand artwork and give the macOS tile
// the same 84% optical footprint as the neighboring application icons.
let source = CommandLine.arguments[1], destination = CommandLine.arguments[2]
guard let image = NSImage(contentsOfFile: source),
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Icon rendering unavailable") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: 1024, height: 1024).fill(using: .copy)
image.draw(in: NSRect(x: 82, y: 82, width: 860, height: 860), from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Icon encoding failed") }
try png.write(to: URL(fileURLWithPath: destination), options: .atomic)
