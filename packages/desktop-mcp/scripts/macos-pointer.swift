import CoreGraphics
import Foundation

enum PointerError: Error {
  case invalidUsage(String)
}

func parseDouble(_ value: String, _ name: String) throws -> Double {
  guard let parsed = Double(value) else {
    throw PointerError.invalidUsage("Invalid \(name): \(value)")
  }
  return parsed
}

func parseInt(_ value: String, _ name: String) throws -> Int {
  guard let parsed = Int(value) else {
    throw PointerError.invalidUsage("Invalid \(name): \(value)")
  }
  return parsed
}

func mouseButton(from raw: String) -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
  switch raw.lowercased() {
  case "right":
    return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
  case "middle":
    return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
  default:
    return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
  }
}

func moveMouse(x: Double, y: Double) {
  let point = CGPoint(x: x, y: y)
  let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
  event?.post(tap: .cghidEventTap)
}

func clickMouse(x: Double, y: Double, buttonName: String, clicks: Int) {
  let point = CGPoint(x: x, y: y)
  let (button, downType, upType, _) = mouseButton(from: buttonName)
  moveMouse(x: x, y: y)
  for _ in 0..<max(1, clicks) {
    let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button)
    let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
  }
}

func dragMouse(startX: Double, startY: Double, endX: Double, endY: Double, buttonName: String, steps: Int) {
  let startPoint = CGPoint(x: startX, y: startY)
  let (button, downType, upType, dragType) = mouseButton(from: buttonName)
  moveMouse(x: startX, y: startY)
  let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: startPoint, mouseButton: button)
  down?.post(tap: .cghidEventTap)

  let stepCount = max(2, steps)
  for step in 1...stepCount {
    let progress = Double(step) / Double(stepCount)
    let x = startX + (endX - startX) * progress
    let y = startY + (endY - startY) * progress
    let point = CGPoint(x: x, y: y)
    let drag = CGEvent(mouseEventSource: nil, mouseType: dragType, mouseCursorPosition: point, mouseButton: button)
    drag?.post(tap: .cghidEventTap)
    usleep(12000)
  }

  let endPoint = CGPoint(x: endX, y: endY)
  let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: endPoint, mouseButton: button)
  up?.post(tap: .cghidEventTap)
}

func scrollMouse(deltaX: Int32, deltaY: Int32, x: Double?, y: Double?) {
  if let x, let y {
    moveMouse(x: x, y: y)
  }
  let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0)
  event?.post(tap: .cghidEventTap)
}

do {
  let args = CommandLine.arguments.dropFirst()
  guard let action = args.first else {
    throw PointerError.invalidUsage("Usage: macos-pointer.swift <move|click|drag|scroll> ...")
  }

  switch action {
  case "move":
    guard args.count >= 3 else {
      throw PointerError.invalidUsage("Usage: macos-pointer.swift move <x> <y>")
    }
    let x = try parseDouble(String(args[1]), "x")
    let y = try parseDouble(String(args[2]), "y")
    moveMouse(x: x, y: y)
  case "click":
    guard args.count >= 5 else {
      throw PointerError.invalidUsage("Usage: macos-pointer.swift click <x> <y> <button> <clicks>")
    }
    let x = try parseDouble(String(args[1]), "x")
    let y = try parseDouble(String(args[2]), "y")
    let button = String(args[3])
    let clicks = try parseInt(String(args[4]), "clicks")
    clickMouse(x: x, y: y, buttonName: button, clicks: clicks)
  case "drag":
    guard args.count >= 7 else {
      throw PointerError.invalidUsage("Usage: macos-pointer.swift drag <startX> <startY> <endX> <endY> <button> <steps>")
    }
    let startX = try parseDouble(String(args[1]), "startX")
    let startY = try parseDouble(String(args[2]), "startY")
    let endX = try parseDouble(String(args[3]), "endX")
    let endY = try parseDouble(String(args[4]), "endY")
    let button = String(args[5])
    let steps = try parseInt(String(args[6]), "steps")
    dragMouse(startX: startX, startY: startY, endX: endX, endY: endY, buttonName: button, steps: steps)
  case "scroll":
    guard args.count >= 5 else {
      throw PointerError.invalidUsage("Usage: macos-pointer.swift scroll <deltaX> <deltaY> <x|keep> <y|keep>")
    }
    let deltaX = Int32(try parseInt(String(args[1]), "deltaX"))
    let deltaY = Int32(try parseInt(String(args[2]), "deltaY"))
    let x = String(args[3]).lowercased() == "keep" ? nil : try parseDouble(String(args[3]), "x")
    let y = String(args[4]).lowercased() == "keep" ? nil : try parseDouble(String(args[4]), "y")
    scrollMouse(deltaX: deltaX, deltaY: deltaY, x: x, y: y)
  default:
    throw PointerError.invalidUsage("Unknown action: \(action)")
  }
} catch {
  fputs("[desktop-mcp] \(error)\n", stderr)
  exit(1)
}
