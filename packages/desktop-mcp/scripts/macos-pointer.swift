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

func mouseButton(from raw: String) -> (CGMouseButton, CGEventType, CGEventType) {
  switch raw.lowercased() {
  case "right":
    return (.right, .rightMouseDown, .rightMouseUp)
  case "middle":
    return (.center, .otherMouseDown, .otherMouseUp)
  default:
    return (.left, .leftMouseDown, .leftMouseUp)
  }
}

func moveMouse(x: Double, y: Double) {
  let point = CGPoint(x: x, y: y)
  let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
  event?.post(tap: .cghidEventTap)
}

func clickMouse(x: Double, y: Double, buttonName: String, clicks: Int) {
  let point = CGPoint(x: x, y: y)
  let (button, downType, upType) = mouseButton(from: buttonName)
  moveMouse(x: x, y: y)
  for _ in 0..<max(1, clicks) {
    let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button)
    let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
  }
}

do {
  let args = CommandLine.arguments.dropFirst()
  guard let action = args.first else {
    throw PointerError.invalidUsage("Usage: macos-pointer.swift <move|click> <x> <y> [button] [clicks]")
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
  default:
    throw PointerError.invalidUsage("Unknown action: \(action)")
  }
} catch {
  fputs("[desktop-mcp] \(error)\n", stderr)
  exit(1)
}
