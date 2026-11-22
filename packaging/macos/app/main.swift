// Pi Pocket.app: the macOS desktop app. A WKWebView window and a menu bar item around a `pi-pocket --desktop` launcher.
//
// The owner token goes only in a header of a request to this Mac: never on a command line, in a title, or in the log.
// A newer pi-pocket package replaces nothing here, so this app uses only --desktop, launcher-running.json,
// /api/pocket/info, /api/sign-in-link, and /api/restart.
import Cocoa
import UserNotifications
import WebKit

let appVersion = "0.0.0-dev"  // build.sh puts the package's version here.
let openNotice = Notification.Name("io.github.tannermidd.pi-pocket.app.open")
let quitNotice = Notification.Name("io.github.tannermidd.pi-pocket.app.quit")
let home = FileManager.default.homeDirectoryForCurrentUser
let appFolder = home.appendingPathComponent("Library/Application Support/Pi Pocket")
let dataFolder: URL = {
    if let data = ProcessInfo.processInfo.environment["PI_POCKET_DIR"], !data.isEmpty {
        return URL(fileURLWithPath: (data as NSString).expandingTildeInPath)
    }

    return home.appendingPathComponent(".pi-pocket")
}()
let logFolder = home.appendingPathComponent("Library/Logs/Pi Pocket")
let logFile = logFolder.appendingPathComponent("launcher.log")

func bridgeScript(origin: String) -> String {
    return """
        (() => {
            if (window.top !== window || location.origin !== \(jsString(origin))) { return; }
            const post = (message) => window.webkit.messageHandlers.pocket.postMessage(message);
            let listener = null;
            let shown = true;
            Object.defineProperty(window, "__pocketHostEvent", {
                value: (event) => {
                    if (event.type === "visibility") { shown = event.visible; }
                    try { listener?.({ type: event.type, url: event.url }); } catch (error) { console.error(error); }
                },
            });
            window.pocketHost = Object.freeze({
                kind: "pi-pocket-macos",
                apiVersion: 1,
                capabilities: ["badge", "notify", "visibility", "open"],
                setBadge: (count) => post({ type: "badge", count: Number(count) || 0 }),
                notify: (message) => post({
                    type: "notify",
                    title: String(message?.title ?? "Pi Pocket"),
                    body: String(message?.body ?? ""),
                    url: String(message?.url ?? "/"),
                    tag: String(message?.tag ?? ""),
                }),
                visible: () => shown,
                subscribe: (next) => { listener = typeof next === "function" ? next : null; },
            });
        })();
        """
}

func jsString(_ text: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [text])
    let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"

    return String(array.dropFirst().dropLast())
}

/// Same order as compareVersions in place-app.mjs.
func compareVersions(_ a: String, _ b: String) -> Int {
    func parse(_ text: String) -> (core: [Int], pre: [String]) {
        let plain = String(text.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)[0])
        let parts = plain.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let core = parts[0].split(separator: ".", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
        let pre = parts.count > 1 ? parts[1].split(separator: ".", omittingEmptySubsequences: false).map(String.init) : []

        return (core, pre)
    }

    func digits(_ text: String) -> Bool {
        return !text.isEmpty && text.allSatisfy { $0 >= "0" && $0 <= "9" }
    }

    let left = parse(a)
    let right = parse(b)

    for index in 0..<3 {
        let x = index < left.core.count ? left.core[index] : 0
        let y = index < right.core.count ? right.core[index] : 0

        if x != y {
            return x < y ? -1 : 1
        }
    }

    if left.pre.isEmpty || right.pre.isEmpty {
        return left.pre.isEmpty == right.pre.isEmpty ? 0 : (left.pre.isEmpty ? 1 : -1)
    }

    for index in 0..<max(left.pre.count, right.pre.count) {
        if index >= left.pre.count || index >= right.pre.count {
            return index >= left.pre.count ? -1 : 1
        }

        let x = left.pre[index]
        let y = right.pre[index]
        let order: Int

        if digits(x), digits(y), let m = Int(x), let n = Int(y) {
            order = m < n ? -1 : m > n ? 1 : 0
        } else {
            order = x < y ? -1 : x > y ? 1 : 0
        }

        if order != 0 {
            return order
        }
    }

    return 0
}

/// An older package than this app is one the install did not replace: an older launcher refuses --desktop.
func packageProblem() -> (title: String, advice: String)? {
    let folder = appFolder.appendingPathComponent("app/lib/node_modules/pi-pocket")
    let again = "Install Pi Pocket \(appVersion) again: open its .pkg file. Your sessions and settings stay."

    guard FileManager.default.fileExists(atPath: folder.appendingPathComponent("bin/pi-pocket.js").path),
        let data = try? Data(contentsOf: folder.appendingPathComponent("package.json")),
        let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let version = manifest["version"] as? String
    else {
        return ("Pi Pocket is not fully installed: \(folder.path) holds no pi-pocket package.", again)
    }

    if appVersion != "0.0.0-dev" && compareVersions(version, appVersion) < 0 {
        return (
            "The pi-pocket package of Pi Pocket is version \(version), older than this app (\(appVersion)).",
            "The install did not finish putting the package in place, so Pi Pocket cannot start. \(again)"
        )
    }

    return nil
}

func runningServer(pid: Int32?) -> URL? {
    guard let data = try? Data(contentsOf: dataFolder.appendingPathComponent("launcher-running.json")),
        let running = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let found = running["pid"] as? Int, let address = running["url"] as? String,
        let url = URL(string: address)
    else {
        return nil
    }

    if let pid = pid, Int32(found) != pid {
        return nil
    }

    // Signal 0 checks that the process is there without touching it.
    if kill(pid_t(found), 0) != 0 {
        return nil
    }

    guard let info = try? request("GET", url.appendingPathComponent("api/pocket/info"), token: nil) else {
        return nil
    }

    return String(data: info, encoding: .utf8)?.contains("\"pi-pocket\"") == true ? url : nil
}

func ownerToken() throws -> String {
    let data = try Data(contentsOf: dataFolder.appendingPathComponent("config.json"))

    guard let config = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let token = config["ownerToken"] as? String
    else {
        throw NSError(domain: "PiPocket", code: 1, userInfo: [NSLocalizedDescriptionKey: "config.json has no owner token"])
    }

    return token
}

func request(_ method: String, _ url: URL, token: String?) throws -> Data {
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)

    request.httpMethod = method
    request.httpShouldHandleCookies = false

    if let token = token {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    if method != "GET" {
        request.setValue("1", forHTTPHeaderField: "X-Pocket")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
    }

    let configuration = URLSessionConfiguration.ephemeral

    configuration.connectionProxyDictionary = [:]
    let session = URLSession(configuration: configuration)
    let done = DispatchSemaphore(value: 0)
    var result: Result<Data, Error> = .failure(URLError(.timedOut))

    session.dataTask(with: request) { data, response, error in
        if let error = error {
            result = .failure(error)
        } else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
            result = .failure(URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "HTTP \(response.statusCode)"]))
        } else {
            result = .success(data ?? Data())
        }

        done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 15)
    session.finishTasksAndInvalidate()

    return try result.get()
}

/// Opened to append: this app and its launcher write to the log at once.
func appendHandle() throws -> FileHandle {
    try FileManager.default.createDirectory(at: logFolder, withIntermediateDirectories: true)
    let descriptor = open(logFile.path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)

    if descriptor < 0 {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }

    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
}

func log(_ line: String) {
    guard let handle = try? appendHandle() else {
        return
    }

    handle.write(Data("\(line)\n".utf8))
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate
{
    var window: NSWindow?
    var webView: WKWebView?
    // Windows that pages opened (an artifact's "Open tab"), each kept until it closes, with its close observer.
    var popups: [NSWindow: NSObjectProtocol] = [:]
    var statusItem: NSStatusItem?
    var openItem: NSMenuItem?
    var restartItem: NSMenuItem?
    var launcher: Process?
    var lifeline: Pipe?
    var server: URL?
    var ready = false
    var openWhenReady = !CommandLine.arguments.contains("--hidden")
    var quitting = false
    var stopped = false
    var checkedSignIn = false
    var termSource: DispatchSourceSignal?

    func applicationWillFinishLaunching(_ notification: Notification) {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            // LaunchServices can list one that just quit for a moment: only a live process counts.
            .filter { $0.processIdentifier != getpid() && !$0.isTerminated && kill($0.processIdentifier, 0) == 0 }
        let center = DistributedNotificationCenter.default()

        if CommandLine.arguments.contains("--quit") {
            center.postNotificationName(quitNotice, object: nil, userInfo: nil, deliverImmediately: true)
            exit(0)
        }

        if let other = others.first {
            log("Pi Pocket.app runs already (process \(other.processIdentifier)): this one exits.")

            if openWhenReady {
                center.postNotificationName(openNotice, object: nil, userInfo: nil, deliverImmediately: true)
                other.activate(options: [])
            }

            exit(0)
        }

        center.addObserver(forName: openNotice, object: nil, queue: .main) { [weak self] _ in self?.openWindow() }
        center.addObserver(forName: quitNotice, object: nil, queue: .main) { _ in NSApp.terminate(nil) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(openWhenReady ? .regular : .accessory)
        NSApp.mainMenu = mainMenu()
        makeStatusItem()
        UNUserNotificationCenter.current().delegate = self
        signal(SIGTERM, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)

        term.setEventHandler { NSApp.terminate(nil) }
        term.resume()
        termSource = term

        if openWhenReady {
            NSApp.activate(ignoringOtherApps: true)
        }

        DispatchQueue.global().async { self.start() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWindow()

        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func start() {
        if let running = runningServer(pid: nil) {
            // Another launcher runs it, such as Pi Pocket (console): use it, and leave it running on Quit.
            DispatchQueue.main.async { self.becameReady(running) }

            return
        }

        if let problem = packageProblem() {
            DispatchQueue.main.async { self.fail(problem.title, advice: problem.advice) }

            return
        }

        do {
            try startLauncher()
        } catch {
            DispatchQueue.main.async { self.fail("Pi Pocket could not start: \(error.localizedDescription)") }

            return
        }

        let started = Date()

        // An update that does not start can take the launcher 5 minutes to undo.
        while Date().timeIntervalSince(started) < 6 * 60 {
            guard let launcher = launcher, launcher.isRunning else {
                return
            }

            if let running = runningServer(pid: launcher.processIdentifier) {
                DispatchQueue.main.async { self.becameReady(running) }

                return
            }

            Thread.sleep(forTimeInterval: 0.25)
        }

        DispatchQueue.main.async { self.fail("Pi Pocket did not get ready in 6 minutes.") }
    }

    func startLauncher() throws {
        let script = appFolder.appendingPathComponent("pi-pocket")

        guard FileManager.default.isExecutableFile(atPath: script.path) else {
            throw NSError(domain: "PiPocket", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Pi Pocket is not fully installed in \(appFolder.path). Install it again.",
            ])
        }

        try FileManager.default.createDirectory(at: logFolder, withIntermediateDirectories: true)
        let old = logFolder.appendingPathComponent("launcher.old.log")

        try? FileManager.default.removeItem(at: old)
        try? FileManager.default.moveItem(at: logFile, to: old)
        log("Pi Pocket desktop app \(appVersion), \(Date())")
        let output = try appendHandle()

        // The user's login shell, as Terminal starts it, for the PATH of ~/.zprofile. Only shells that take sh's -c.
        var shell = "/bin/zsh"

        if let entry = getpwuid(getuid()), let path = entry.pointee.pw_shell {
            let own = String(cString: path)

            if ["zsh", "bash", "sh", "ksh", "dash"].contains((own as NSString).lastPathComponent),
                FileManager.default.isExecutableFile(atPath: own)
            {
                shell = own
            }
        }

        let process = Process()
        let input = Pipe()

        process.executableURL = URL(fileURLWithPath: shell)
        // The data folder by name: the login shell may set PI_POCKET_DIR to another one than this app reads.
        process.arguments = ["-l", "-c", "exec \"$0\" --desktop --data \"$1\"", script.path, dataFolder.path]
        process.currentDirectoryURL = home
        process.standardInput = input
        process.standardOutput = output
        process.standardError = output
        var environment = ProcessInfo.processInfo.environment

        environment["NO_COLOR"] = "1"
        process.environment = environment
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async { self?.launcherEnded(ended) }
        }
        // Before it runs: one that ends at once must still count as this app's launcher.
        launcher = process
        lifeline = input

        do {
            try process.run()
        } catch {
            launcher = nil
            lifeline = nil

            throw error
        }

        try? output.close()
    }

    func becameReady(_ url: URL) {
        server = url
        ready = true
        openItem?.isEnabled = true
        restartItem?.isEnabled = true
        statusItem?.button?.toolTip = launcher == nil ? "Pi Pocket (started by another launcher)" : "Pi Pocket"

        if openWhenReady {
            openWindow()
        }
    }

    func launcherEnded(_ process: Process) {
        if quitting || process !== launcher {
            return
        }

        if process.terminationStatus == 0 {
            stopped = true
            NSApp.terminate(nil)

            return
        }

        fail("\(ready ? "Pi Pocket stopped" : "Pi Pocket could not start") (exit code \(process.terminationStatus)).")
    }

    func fail(_ message: String, advice: String? = nil) {
        if quitting {
            return
        }

        log("Error: \(message) \(advice ?? "")")
        let alert = NSAlert()

        alert.alertStyle = .critical
        alert.messageText = message
        alert.informativeText = advice ?? (launcher == nil ? "" : "The details are in \(logFile.path).")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        NSApp.terminate(nil)
    }

    @objc func restartServer() {
        guard let server = server else {
            return
        }

        DispatchQueue.global().async {
            do {
                _ = try request("POST", server.appendingPathComponent("api/restart"), token: try ownerToken())
            } catch {
                DispatchQueue.main.async {
                    let alert = NSAlert()

                    alert.messageText = "Could not restart the server: \(error.localizedDescription)"
                    alert.runModal()
                }
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true

        guard let process = launcher, process.isRunning, !stopped else {
            return .terminateNow
        }

        log("Quit: stopping the launcher.")
        try? lifeline?.fileHandleForWriting.close()
        kill(process.processIdentifier, SIGTERM)
        let started = Date()

        while kill(process.processIdentifier, 0) == 0 && Date().timeIntervalSince(started) < 20 {
            var status: Int32 = 0

            // The launcher is this app's child: reap it here, so that the check above sees it gone.
            if waitpid(process.processIdentifier, &status, WNOHANG) == process.processIdentifier {
                break
            }

            usleep(100_000)
        }

        if kill(process.processIdentifier, 0) == 0 {
            log("Quit: the launcher did not stop in 20 seconds; killing it.")
            kill(process.processIdentifier, SIGKILL)
        }

        log("Quit: done.")

        return .terminateNow
    }

    func mainMenu() -> NSMenu {
        let bar = NSMenu()

        func menu(_ title: String, _ items: [NSMenuItem]) {
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: title)

            items.forEach { submenu.addItem($0) }
            holder.submenu = submenu
            bar.addItem(holder)
        }

        func item(_ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command)
            -> NSMenuItem
        {
            let made = NSMenuItem(title: title, action: action, keyEquivalent: key)

            made.keyEquivalentModifierMask = modifiers

            return made
        }

        menu("Pi Pocket", [
            item("About Pi Pocket", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Restart Server", #selector(restartServer)),
            .separator(),
            item("Hide Pi Pocket", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Pi Pocket", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        menu("View", [
            item("Reload", #selector(reload), "r"),
            item("Actual Size", #selector(actualSize), "0"),
            item("Zoom In", #selector(zoomIn), "+"),
            item("Zoom Out", #selector(zoomOut), "-"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        menu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])

        return bar
    }

    func makeStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        let open = NSMenuItem(title: "Open Pi Pocket", action: #selector(openFromMenu), keyEquivalent: "")
        let restart = NSMenuItem(title: "Restart Server", action: #selector(restartServer), keyEquivalent: "")

        item.button?.title = "π"
        item.button?.toolTip = "Pi Pocket (starting)"
        open.isEnabled = false
        restart.isEnabled = false
        menu.autoenablesItems = false
        menu.addItem(open)
        menu.addItem(restart)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Pi Pocket", action: #selector(NSApplication.terminate(_:)), keyEquivalent: ""))
        item.menu = menu
        statusItem = item
        openItem = open
        restartItem = restart
    }

    @objc func openFromMenu() {
        openWindow()
    }

    // The view of the window in front: the main one, or a page's own window.
    var frontView: WKWebView? {
        (NSApp.keyWindow?.contentView as? WKWebView) ?? webView
    }

    @objc func reload() {
        frontView?.reload()
    }

    @objc func actualSize() {
        frontView?.pageZoom = 1
    }

    @objc func zoomIn() {
        frontView?.pageZoom = min(3, (frontView?.pageZoom ?? 1) + 0.1)
    }

    @objc func zoomOut() {
        frontView?.pageZoom = max(0.5, (frontView?.pageZoom ?? 1) - 0.1)
    }

    func openWindow() {
        guard ready, let server = server else {
            openWhenReady = true

            return
        }

        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        if let window = window {
            window.makeKeyAndOrderFront(nil)
            visibilityChanged()

            if webView?.url == nil {
                signIn(server)
            }

            return
        }

        let configuration = WKWebViewConfiguration()
        let origin = "\(server.scheme ?? "http")://\(server.host ?? "127.0.0.1")\(server.port.map { ":\($0)" } ?? "")"

        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "PiPocketMac/\(appVersion)"
        configuration.userContentController.addUserScript(
            WKUserScript(source: bridgeScript(origin: origin), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController.add(self, name: "pocket")
        configuration.preferences.isElementFullscreenEnabled = true
        let view = WKWebView(frame: .zero, configuration: configuration)

        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.allowsMagnification = true

        // For debugging only: defaults write io.github.tannermidd.pi-pocket.launcher WebInspector -bool true
        if #available(macOS 13.3, *) {
            view.isInspectable = UserDefaults.standard.bool(forKey: "WebInspector")
        }

        let made = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)

        made.title = "Pi Pocket"
        made.minSize = NSSize(width: 420, height: 400)
        made.isReleasedWhenClosed = false
        made.contentView = view
        made.delegate = self
        made.tabbingMode = .disallowed
        made.center()
        made.setFrameAutosaveName("Pi Pocket")
        window = made
        webView = view
        made.makeKeyAndOrderFront(nil)
        signIn(server)
    }

    func signIn(_ server: URL) {
        DispatchQueue.global().async {
            var target = server.appendingPathComponent("/")

            do {
                let answer = try request("POST", server.appendingPathComponent("api/sign-in-link"), token: try ownerToken())

                if let link = try JSONSerialization.jsonObject(with: answer) as? [String: Any],
                    let path = link["path"] as? String, path.hasPrefix("/login?"),
                    let url = URL(string: path, relativeTo: server)
                {
                    target = url.absoluteURL
                }
            } catch {
                log("No one-time sign-in link: \(error.localizedDescription)")
            }

            DispatchQueue.main.async { self.webView?.load(URLRequest(url: target)) }
        }
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        visibilityChanged(visible: false)
    }

    func windowDidMiniaturize(_ notification: Notification) {
        visibilityChanged(visible: false)
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        visibilityChanged()
    }

    func visibilityChanged(visible: Bool? = nil) {
        let shown = visible ?? (window?.isVisible == true && window?.isMiniaturized == false)

        webView?.evaluateJavaScript("window.__pocketHostEvent?.({ type: 'visibility', visible: \(shown) })")
    }

    func sameOrigin(_ url: URL?) -> Bool {
        guard let url = url, let server = server else {
            return false
        }

        return url.scheme == server.scheme && url.host == server.host && url.port == server.port
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if action.shouldPerformDownload {
            decisionHandler(.download)

            return
        }

// Frames (artifacts) may load what they load.
        let url = action.request.url
        let local = sameOrigin(url) || ["about", "blob", "data"].contains(url?.scheme ?? "")

        if action.targetFrame?.isMainFrame != false && !local {
            if let url = url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }

            decisionHandler(.cancel)

            return
        }

        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""

        decisionHandler(!response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? home
        let name = (suggestedFilename as NSString).lastPathComponent
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var target = folder.appendingPathComponent(name.isEmpty ? "download" : name)
        var count = 1

        while FileManager.default.fileExists(atPath: target.path) {
            count += 1
            target = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(count)" : "\(base) \(count).\(ext)")
        }

        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound.beep()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        visibilityChanged()

        if !checkedSignIn {
            checkedSignIn = true
            webView.callAsyncJavaScript(
                "return (await fetch('/api/me')).status", arguments: [:], in: nil, in: .page
            ) { result in
                if case .success(let status) = result {
                    log(status as? Int == 200 ? "The window is signed in." : "The window is not signed in (\(status)).")
                }
            }
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url {
            if sameOrigin(url) {
                return popup(configuration)
            } else if ["http", "https", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
        }

        return nil
    }

    // A window of its own for a same-origin page: WebKit loads the page in the view it gets back, with the same session.
    func popup(_ configuration: WKWebViewConfiguration) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: configuration)

        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.allowsMagnification = true

        if #available(macOS 13.3, *) {
            view.isInspectable = UserDefaults.standard.bool(forKey: "WebInspector")
        }

        let made = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1000, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)

        made.title = "Pi Pocket"
        made.minSize = NSSize(width: 420, height: 400)
        made.isReleasedWhenClosed = false
        made.contentView = view
        made.tabbingMode = .disallowed
        made.center()
        popups[made] = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: made, queue: .main
        ) { [weak self] _ in
            // After the close: the window is not let go while it closes.
            DispatchQueue.main.async {
                if let observer = self?.popups.removeValue(forKey: made) {
                    NotificationCenter.default.removeObserver(observer)
                }
            }
        }
        made.makeKeyAndOrderFront(nil)

        return view
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView !== self.webView {
            webView.window?.close()
        }
    }

    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()

        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window ?? NSWindow()) { answer in
            completionHandler(answer == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()

        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()

        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(
        _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))

        field.stringValue = defaultText ?? ""
        alert.messageText = prompt
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the top frame of the server's own origin: never an artifact's frame, never another site.
        let origin = message.frameInfo.securityOrigin

        guard message.frameInfo.isMainFrame, let server = server, origin.protocol == server.scheme,
            origin.host == server.host, origin.port == (server.port ?? 0),
            let body = message.body as? [String: Any], let type = body["type"] as? String
        else {
            return
        }

        if type == "badge" {
            let count = body["count"] as? Int ?? 0

            NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        } else if type == "notify" {
            notify(body)
        }
    }

    func notify(_ body: [String: Any]) {
        let center = UNUserNotificationCenter.current()

        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else {
                return
            }

            let content = UNMutableNotificationContent()

            content.title = String((body["title"] as? String ?? "Pi Pocket").prefix(200))
            content.body = String((body["body"] as? String ?? "").prefix(400))
            content.sound = .default
            content.userInfo = ["url": body["url"] as? String ?? "/"]
            let tag = body["tag"] as? String ?? ""

            center.add(UNNotificationRequest(identifier: tag.isEmpty ? UUID().uuidString : tag, content: content, trigger: nil))
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let path = response.notification.request.content.userInfo["url"] as? String ?? "/"

        DispatchQueue.main.async {
            self.openWindow()

            if path.hasPrefix("/") && !path.hasPrefix("//") {
                self.webView?.evaluateJavaScript("window.__pocketHostEvent?.({ type: 'open', url: \(jsString(path)) })")
            }
        }

        completionHandler()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()

app.delegate = delegate
app.run()
