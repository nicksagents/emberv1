import Foundation
import ImageIO
import Vision

struct OcrBlock: Codable {
  let text: String
  let confidence: Double
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

enum OcrError: Error {
  case invalidUsage(String)
}

guard CommandLine.arguments.count >= 2 else {
  fputs("[desktop-mcp] Usage: macos-ocr.swift <imagePath>\n", stderr)
  exit(1)
}

let imagePath = CommandLine.arguments[1]
let url = URL(fileURLWithPath: imagePath)

guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  fputs("[desktop-mcp] Failed to open image at \(imagePath)\n", stderr)
  exit(1)
}

let imageWidth = Double(image.width)
let imageHeight = Double(image.height)

var blocks: [OcrBlock] = []

let request = VNRecognizeTextRequest { request, error in
  if let error {
    fputs("[desktop-mcp] Vision OCR failed: \(error)\n", stderr)
    exit(1)
  }

  guard let observations = request.results as? [VNRecognizedTextObservation] else {
    return
  }

  blocks = observations.compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else {
      return nil
    }
    let box = observation.boundingBox
    return OcrBlock(
      text: candidate.string,
      confidence: Double(candidate.confidence),
      x: box.origin.x * imageWidth,
      y: (1.0 - box.origin.y - box.height) * imageHeight,
      width: box.width * imageWidth,
      height: box.height * imageHeight
    )
  }
}

request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

do {
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  try handler.perform([request])
  let data = try JSONEncoder().encode(blocks)
  if let json = String(data: data, encoding: .utf8) {
    print(json)
  } else {
    throw OcrError.invalidUsage("Failed to encode OCR output.")
  }
} catch {
  fputs("[desktop-mcp] \(error)\n", stderr)
  exit(1)
}
