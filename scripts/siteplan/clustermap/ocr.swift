import Foundation
import Vision
import AppKit
// usage: swift ocr.swift <image>  -> lines: text<TAB>x<TAB>y<TAB>w<TAB>h (pixels, origin top-left)
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
let W = Double(cg.width), H = Double(cg.height)
let req = VNRecognizeTextRequest { r, _ in
  for o in (r.results as? [VNRecognizedTextObservation]) ?? [] {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox
    print("\(c.string)\t\(b.minX * W)\t\((1 - b.maxY) * H)\t\(b.width * W)\t\(b.height * H)")
  }
}
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
req.minimumTextHeight = 0.0
try VNImageRequestHandler(cgImage: cg).perform([req])
