// BottyQuick — global quick-capture panel for botty.
//
// A menu-bar accessory app (no Dock icon) with a floating, Spotlight-style
// panel. Whatever you type is POSTed to the agent's chat ingress
// (POST /api/chat/message) — the chat model routes it from there
// (capture_task for durable work, the commitment pass for timed reminders).
//
// Hotkeys:
//   - Option+Space — always on (Carbon hotkey, no permissions needed).
//   - Double-tap Option — like the Claude desktop popup. Needs Accessibility
//     permission (global key monitors); the menu-bar item offers the grant.
//
// Flags: --send "text" (headless post, for testing) · --show (open panel at
// launch) · --url http://127.0.0.1:PORT (override; also env BOTTY_URL).

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import ServiceManagement

// MARK: - Config

let cliArgs = CommandLine.arguments
func argValue(_ flag: String) -> String? {
  guard let i = cliArgs.firstIndex(of: flag), i + 1 < cliArgs.count else { return nil }
  return cliArgs[i + 1]
}

let baseURL: String = {
  let raw = argValue("--url") ?? ProcessInfo.processInfo.environment["BOTTY_URL"]
    ?? "http://127.0.0.1:4820"
  return raw.hasSuffix("/") ? String(raw.dropLast()) : raw
}()

// MARK: - Agent client

func postNote(_ text: String, completion: @escaping (Result<String, Error>) -> Void) {
  guard let url = URL(string: "\(baseURL)/api/chat/message") else {
    completion(.failure(NSError(domain: "botty", code: 1,
      userInfo: [NSLocalizedDescriptionKey: "bad BOTTY_URL: \(baseURL)"])))
    return
  }
  var req = URLRequest(url: url, timeoutInterval: 6)
  req.httpMethod = "POST"
  req.setValue("application/json", forHTTPHeaderField: "Content-Type")
  req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text])
  URLSession.shared.dataTask(with: req) { data, resp, err in
    if let err {
      completion(.failure(err))
      return
    }
    let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      completion(.failure(NSError(domain: "botty", code: status,
        userInfo: [NSLocalizedDescriptionKey: "HTTP \(status) \(body.prefix(200))"])))
      return
    }
    let turnId = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
      as? [String: Any])?["turnId"] as? String ?? "?"
    completion(.success(turnId))
  }.resume()
}

// Headless mode: post and exit (used by tests / scripting).
if let text = argValue("--send") {
  let sema = DispatchSemaphore(value: 0)
  var code: Int32 = 0
  postNote(text) { result in
    switch result {
    case .success(let turnId): print("sent turnId=\(turnId)")
    case .failure(let err):
      FileHandle.standardError.write(Data("send failed: \(err.localizedDescription)\n".utf8))
      code = 1
    }
    sema.signal()
  }
  sema.wait()
  exit(code)
}

// MARK: - Panel

final class CapturePanel: NSPanel {
  override var canBecomeKey: Bool { true }
}

final class PanelController: NSObject, NSTextFieldDelegate, NSWindowDelegate {
  static let width: CGFloat = 640
  static let height: CGFloat = 64

  let panel: CapturePanel
  let field = NSTextField()
  let hint = NSTextField(labelWithString: "")
  private var generation = 0  // invalidates stale auto-hide timers

  override init() {
    panel = CapturePanel(
      contentRect: NSRect(x: 0, y: 0, width: Self.width, height: Self.height),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered, defer: true)
    super.init()

    panel.isFloatingPanel = true
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = true
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.delegate = self

    let effect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: Self.width, height: Self.height))
    effect.material = .hudWindow
    effect.blendingMode = .behindWindow
    effect.state = .active
    effect.wantsLayer = true
    effect.layer?.cornerRadius = 16
    effect.layer?.masksToBounds = true
    effect.layer?.borderWidth = 1
    effect.layer?.borderColor = NSColor.white.withAlphaComponent(0.12).cgColor
    panel.contentView = effect

    let icon = NSImageView(frame: NSRect(x: 20, y: (Self.height - 24) / 2, width: 24, height: 24))
    icon.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "botty")
    icon.symbolConfiguration = .init(pointSize: 20, weight: .medium)
    icon.contentTintColor = NSColor.systemOrange
    effect.addSubview(icon)

    field.frame = NSRect(x: 56, y: (Self.height - 26) / 2, width: Self.width - 56 - 120, height: 26)
    field.font = .systemFont(ofSize: 18)
    field.isBordered = false
    field.drawsBackground = false
    field.focusRingType = .none
    field.textColor = .white
    field.placeholderString = "Tell botty — note, reminder, question…"
    field.delegate = self
    effect.addSubview(field)

    hint.frame = NSRect(x: Self.width - 116, y: (Self.height - 16) / 2, width: 100, height: 16)
    hint.alignment = .right
    hint.font = .systemFont(ofSize: 11)
    hint.textColor = NSColor.white.withAlphaComponent(0.4)
    effect.addSubview(hint)
    resetHint()
  }

  private func resetHint() {
    hint.stringValue = "↩ send · esc"
    hint.textColor = NSColor.white.withAlphaComponent(0.4)
  }

  func toggle() { panel.isVisible ? hide() : show() }

  func show() {
    generation += 1
    resetHint()
    field.isEnabled = true
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
      ?? NSScreen.main
    if let f = screen?.frame {
      panel.setFrameOrigin(NSPoint(x: f.midX - Self.width / 2,
                                   y: f.minY + f.height * 0.62))
    }
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(field)
  }

  func hide() {
    generation += 1
    panel.orderOut(nil)
  }

  func windowDidResignKey(_ notification: Notification) {
    // Click-away dismisses, like the Claude popup.
    if panel.isVisible { hide() }
  }

  func control(_ control: NSControl, textView: NSTextView,
               doCommandBy selector: Selector) -> Bool {
    switch selector {
    case #selector(NSResponder.insertNewline(_:)): submit(); return true
    case #selector(NSResponder.cancelOperation(_:)): hide(); return true
    default: return false
    }
  }

  private func submit() {
    let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { hide(); return }
    generation += 1
    let gen = generation
    field.isEnabled = false
    hint.stringValue = "sending…"
    postNote(text) { [weak self] result in
      DispatchQueue.main.async {
        guard let self, self.generation == gen else { return }
        switch result {
        case .success:
          self.field.stringValue = ""
          self.field.isEnabled = true
          self.hint.stringValue = "✓ captured"
          self.hint.textColor = NSColor.systemGreen
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            if self.generation == gen { self.hide() }
          }
        case .failure:
          // Keep the text so nothing is lost.
          self.field.isEnabled = true
          self.hint.stringValue = "⚠ botty offline"
          self.hint.textColor = NSColor.systemRed
          self.panel.makeFirstResponder(self.field)
        }
      }
    }
  }
}

// MARK: - Double-tap Option detector (needs Accessibility)

final class DoubleTapOption {
  private let maxHold: TimeInterval = 0.35   // press→release to count as a tap
  private let maxGap: TimeInterval = 0.45    // between taps
  private var optionDownAt: TimeInterval = 0
  private var lastTapAt: TimeInterval = 0
  private var interrupted = false
  private var monitors: [Any] = []
  let action: () -> Void

  init(action: @escaping () -> Void) { self.action = action }

  var installed: Bool { !monitors.isEmpty }

  func install() {
    guard monitors.isEmpty else { return }
    let events: NSEvent.EventTypeMask = [.flagsChanged, .keyDown]
    if let m = NSEvent.addGlobalMonitorForEvents(matching: events, handler: { [weak self] e in
      self?.handle(e)
    }) { monitors.append(m) }
    monitors.append(NSEvent.addLocalMonitorForEvents(matching: events) { [weak self] e in
      self?.handle(e)
      return e
    } as Any)
  }

  private func handle(_ e: NSEvent) {
    if e.type == .keyDown {  // ⌥+key combos are typing, not a tap
      interrupted = true
      lastTapAt = 0
      return
    }
    let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let now = e.timestamp
    if flags == .option {
      optionDownAt = now
      interrupted = false
    } else if flags.isEmpty {
      let wasTap = !interrupted && optionDownAt > 0 && now - optionDownAt < maxHold
      optionDownAt = 0
      guard wasTap else { lastTapAt = 0; return }
      if lastTapAt > 0, now - lastTapAt < maxGap {
        lastTapAt = 0
        DispatchQueue.main.async { self.action() }
      } else {
        lastTapAt = now
      }
    } else {
      interrupted = true
      lastTapAt = 0
    }
  }
}

// MARK: - Carbon hotkey (⌥Space, no permissions needed)

func registerOptionSpace(_ controller: PanelController) {
  var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                eventKind: UInt32(kEventHotKeyPressed))
  let userData = Unmanaged.passUnretained(controller).toOpaque()
  InstallEventHandler(GetApplicationEventTarget(), { _, _, userData -> OSStatus in
    guard let userData else { return noErr }
    let controller = Unmanaged<PanelController>.fromOpaque(userData).takeUnretainedValue()
    DispatchQueue.main.async { controller.toggle() }
    return noErr
  }, 1, &eventType, userData, nil)
  var hotKeyRef: EventHotKeyRef?
  let hotKeyID = EventHotKeyID(signature: OSType(0x424F_5459) /* 'BOTY' */, id: 1)
  RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), hotKeyID,
                      GetApplicationEventTarget(), 0, &hotKeyRef)
}

// MARK: - App delegate (menu bar, wiring)

final class AppDelegate: NSObject, NSApplicationDelegate {
  let controller = PanelController()
  var doubleTap: DoubleTapOption!
  var statusItem: NSStatusItem!
  var axPollTimer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    // Single instance (only meaningful when running from the bundle).
    if let bid = Bundle.main.bundleIdentifier, bid.hasPrefix("io.maxolabs."),
       NSRunningApplication.runningApplications(withBundleIdentifier: bid)
         .contains(where: { $0.processIdentifier != getpid() }) {
      NSApp.terminate(nil)
      return
    }

    doubleTap = DoubleTapOption { [weak self] in self?.controller.toggle() }
    registerOptionSpace(controller)
    if AXIsProcessTrusted() { doubleTap.install() }

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.image = NSImage(systemSymbolName: "sparkles",
                                       accessibilityDescription: "botty quick capture")
    rebuildMenu()

    if cliArgs.contains("--show") { controller.show() }
  }

  func rebuildMenu() {
    let menu = NSMenu()
    let capture = NSMenuItem(title: "Quick Capture", action: #selector(captureAction),
                             keyEquivalent: " ")
    capture.keyEquivalentModifierMask = [.option]
    capture.target = self
    menu.addItem(capture)

    let open = NSMenuItem(title: "Open botty", action: #selector(openBotty), keyEquivalent: "")
    open.target = self
    menu.addItem(open)

    if !AXIsProcessTrusted() {
      let ax = NSMenuItem(title: "Enable double-⌥ hotkey (Accessibility)…",
                          action: #selector(requestAccessibility), keyEquivalent: "")
      ax.target = self
      menu.addItem(ax)
    }

    if Bundle.main.bundleIdentifier != nil {
      let login = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin),
                             keyEquivalent: "")
      login.target = self
      login.state = SMAppService.mainApp.status == .enabled ? .on : .off
      menu.addItem(login)
    }

    menu.addItem(.separator())
    let quit = NSMenuItem(title: "Quit Botty Quick", action: #selector(NSApplication.terminate(_:)),
                          keyEquivalent: "q")
    menu.addItem(quit)
    statusItem.menu = menu
  }

  @objc func captureAction() { controller.toggle() }

  @objc func openBotty() {
    if let url = URL(string: baseURL) { NSWorkspace.shared.open(url) }
  }

  @objc func requestAccessibility() {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    AXIsProcessTrustedWithOptions(opts)
    // Poll so the hotkey starts working as soon as the grant lands (no relaunch).
    axPollTimer?.invalidate()
    var polls = 0
    axPollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
      guard let self else { t.invalidate(); return }
      polls += 1
      if AXIsProcessTrusted() {
        t.invalidate()
        self.doubleTap.install()
        self.rebuildMenu()
      } else if polls > 60 {
        t.invalidate()
      }
    }
  }

  @objc func toggleLogin() {
    let service = SMAppService.mainApp
    if service.status == .enabled {
      try? service.unregister()
    } else {
      try? service.register()
    }
    rebuildMenu()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
