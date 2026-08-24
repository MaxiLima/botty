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
// launch) · --url http://127.0.0.1:PORT (override; also env BOTTY_URL) ·
// --self-test (run the pure submit-guard/error-classification checks and
// exit — no XCTest target exists for this single-file app; see install.sh).

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

// MARK: - Submit guard (pure — see PanelController.submit and --self-test)

/// What a `postNote` completion should do to the panel, decided purely from
/// the generation captured at submit time vs. the controller's generation
/// when the completion lands. `hide()`/`show()` bump the generation, so a
/// click-away (or a reopen) while a send is in flight makes any later
/// completion for that send `.ignored` — the fix for the report's "clicking
/// away during 'sending…' re-sends the text on the next submit" bug: the
/// field is cleared eagerly at submit time (see `submit()`), so there is
/// nothing left in it to accidentally resend either way, but this guard is
/// what stops a stale response from clobbering whatever the user has typed
/// since.
enum SubmitOutcome: Equatable {
  case ignored
  case succeeded
  case failed(String)
}

func resolveSubmitOutcome(sentGeneration: Int, currentGeneration: Int, result: Result<String, Error>) -> SubmitOutcome {
  guard sentGeneration == currentGeneration else { return .ignored }
  switch result {
  case .success: return .succeeded
  case .failure(let err): return .failed(errorHint(for: err))
  }
}

/// Real cause instead of a blanket "offline" — only an actual connectivity
/// failure (host unreachable, no network, timed out, DNS) is reported as
/// offline; an HTTP error from a reachable agent reports its status instead.
func errorHint(for error: Error) -> String {
  let ns = error as NSError
  if ns.domain == NSURLErrorDomain {
    switch ns.code {
    case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost,
      NSURLErrorNotConnectedToInternet, NSURLErrorTimedOut, NSURLErrorCannotFindHost,
      NSURLErrorDNSLookupFailed:
      return "⚠ botty offline"
    default:
      return "⚠ network error"
    }
  }
  if ns.domain == "botty" {
    // postNote stashes the HTTP status as the NSError code for a non-2xx response.
    switch ns.code {
    case 400..<500: return "⚠ rejected (\(ns.code))"
    case 500..<600: return "⚠ agent error (\(ns.code))"
    default: return "⚠ send failed"
    }
  }
  return "⚠ send failed"
}

/// `--self-test`: exercises the pure guard/classification logic above without
/// needing AppKit event delivery or a running agent — the lightweight
/// equivalent of a unit test for this single-file app (no XCTest target
/// exists; see install.sh, which compiles this file directly with swiftc).
/// Run with `swift QuickCapture.swift --self-test`.
func runSelfTest() -> Int32 {
  var failures = 0
  func check(_ name: String, _ cond: @autoclosure () -> Bool) {
    if cond() {
      print("ok - \(name)")
    } else {
      print("FAIL - \(name)")
      failures += 1
    }
  }

  check(
    "same generation + success -> succeeded",
    resolveSubmitOutcome(sentGeneration: 1, currentGeneration: 1, result: .success("t1")) == .succeeded)

  // The click-away-during-send regression: hide()/show() bumped the
  // generation before the response landed — must never touch the field.
  check(
    "generation bumped (click-away) + success -> ignored, not resent",
    resolveSubmitOutcome(sentGeneration: 1, currentGeneration: 2, result: .success("t1")) == .ignored)
  check(
    "generation bumped (click-away) + failure -> ignored",
    resolveSubmitOutcome(sentGeneration: 1, currentGeneration: 2, result: .failure(sampleNetworkError())) == .ignored)

  check(
    "connection-refused reports offline",
    resolveSubmitOutcome(sentGeneration: 1, currentGeneration: 1, result: .failure(sampleNetworkError()))
      == .failed("⚠ botty offline"))
  check(
    "timeout reports offline",
    resolveSubmitOutcome(
      sentGeneration: 1, currentGeneration: 1,
      result: .failure(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))) == .failed("⚠ botty offline"))
  check(
    "5xx from a reachable agent reports the status, not offline",
    resolveSubmitOutcome(
      sentGeneration: 1, currentGeneration: 1,
      result: .failure(NSError(domain: "botty", code: 500, userInfo: [NSLocalizedDescriptionKey: "HTTP 500 boom"])))
      == .failed("⚠ agent error (500)"))
  check(
    "4xx from a reachable agent reports rejected, not offline",
    resolveSubmitOutcome(
      sentGeneration: 1, currentGeneration: 1,
      result: .failure(NSError(domain: "botty", code: 400, userInfo: [NSLocalizedDescriptionKey: "HTTP 400 bad"])))
      == .failed("⚠ rejected (400)"))

  print(failures == 0 ? "\nself-test: \(failures) failures" : "\nself-test: \(failures) FAILURES")
  return failures == 0 ? 0 : 1
}

func sampleNetworkError() -> NSError {
  NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
}

if cliArgs.contains("--self-test") {
  exit(runSelfTest())
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
  static let width: CGFloat = 720
  static let height: CGFloat = 76

  let panel: CapturePanel
  let field = NSTextField()
  let hint = NSTextField(labelWithString: "")
  let sendButton = NSButton()
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
    effect.layer?.cornerRadius = 18
    effect.layer?.masksToBounds = true
    effect.layer?.borderWidth = 1
    effect.layer?.borderColor = NSColor.white.withAlphaComponent(0.15).cgColor
    panel.contentView = effect

    // Deepen the HUD blur toward the near-opaque dark of the Claude popup.
    let tint = NSView(frame: effect.bounds)
    tint.autoresizingMask = [.width, .height]
    tint.wantsLayer = true
    tint.layer?.backgroundColor = NSColor(red: 0.11, green: 0.11, blue: 0.12, alpha: 0.55).cgColor
    effect.addSubview(tint)

    let icon = NSImageView(frame: NSRect(x: 24, y: (Self.height - 28) / 2, width: 28, height: 28))
    icon.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "botty")
    icon.symbolConfiguration = .init(pointSize: 24, weight: .medium)
    icon.contentTintColor = NSColor.systemOrange
    effect.addSubview(icon)

    field.frame = NSRect(x: 66, y: (Self.height - 30) / 2, width: Self.width - 66 - 210, height: 30)
    field.font = .systemFont(ofSize: 20)
    field.isBordered = false
    field.drawsBackground = false
    field.focusRingType = .none
    field.textColor = .white
    field.placeholderAttributedString = NSAttributedString(
      string: "Tell botty — note, reminder, question…",
      attributes: [.foregroundColor: NSColor.white.withAlphaComponent(0.32),
                   .font: NSFont.systemFont(ofSize: 20)])
    field.delegate = self
    effect.addSubview(field)

    hint.frame = NSRect(x: Self.width - 208, y: (Self.height - 16) / 2, width: 130, height: 16)
    hint.alignment = .right
    hint.font = .systemFont(ofSize: 11)
    hint.textColor = NSColor.white.withAlphaComponent(0.35)
    effect.addSubview(hint)

    let buttonSize: CGFloat = 40
    sendButton.frame = NSRect(x: Self.width - buttonSize - 18,
                              y: (Self.height - buttonSize) / 2,
                              width: buttonSize, height: buttonSize)
    sendButton.isBordered = false
    sendButton.wantsLayer = true
    sendButton.layer?.backgroundColor = NSColor.systemOrange.cgColor
    sendButton.layer?.cornerRadius = 10
    sendButton.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: "send")
    sendButton.symbolConfiguration = .init(pointSize: 17, weight: .semibold)
    sendButton.contentTintColor = .white
    sendButton.target = self
    sendButton.action = #selector(submit)
    effect.addSubview(sendButton)
    resetHint()
  }

  private func resetHint() {
    hint.stringValue = "↩ · esc"
    hint.textColor = NSColor.white.withAlphaComponent(0.35)
  }

  func toggle() { panel.isVisible ? hide() : show() }

  func show() {
    generation += 1
    resetHint()
    field.isEnabled = true
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
      ?? NSScreen.main
    if let vf = screen?.visibleFrame {  // excludes Dock/menu bar
      panel.setFrameOrigin(NSPoint(x: vf.midX - Self.width / 2,
                                   y: vf.minY + vf.height * 0.10))
    }
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(field)
    if let editor = panel.fieldEditor(true, for: field) as? NSTextView {
      editor.insertionPointColor = .systemOrange
    }
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

  @objc private func submit() {
    let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { hide(); return }
    generation += 1
    let gen = generation
    field.isEnabled = false
    // Clear eagerly, before the response lands: once a send is in flight its
    // text must never still be sitting in the field to be silently resent —
    // by a click-away (hide() bumps `generation`, orphaning this request's
    // completion) followed by a reopen and a bare Enter. On failure below the
    // text is restored, but only when this is still the active generation.
    field.stringValue = ""
    hint.stringValue = "sending…"
    postNote(text) { [weak self] result in
      DispatchQueue.main.async {
        guard let self else { return }
        switch resolveSubmitOutcome(sentGeneration: gen, currentGeneration: self.generation, result: result) {
        case .ignored:
          return
        case .succeeded:
          self.field.isEnabled = true
          self.hint.stringValue = "✓ captured"
          self.hint.textColor = NSColor.systemGreen
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            if self.generation == gen { self.hide() }
          }
        case .failed(let message):
          // Still the same session (no click-away since) — restore the text
          // so nothing is lost, and report the real cause, not a blanket
          // "offline" for what might be a 4xx/5xx from a perfectly reachable agent.
          self.field.stringValue = text
          self.field.isEnabled = true
          self.hint.stringValue = message
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
