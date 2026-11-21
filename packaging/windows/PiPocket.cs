// Pi Pocket.exe: the Windows desktop app. It runs Pi Pocket with no console window, puts an icon in the notification
// area (Open, Restart server, Quit), and shows the web app in its own window with Edge's app mode, signed in.
//
// build.ps1 compiles it with the C# compiler of the .NET Framework 4.x that every Windows 10 and 11 has, so it needs
// nothing from the internet. It is C# 5, the language that compiler knows. The Start menu entry and the sign-in
// shortcut (with --hidden: the icon only, no window) run it. `Pi Pocket.exe --quit` quits the one that runs, as its
// Quit does.
//
// - One per Windows session: a second start asks the first to open its window, then exits.
// - It uses a launcher that already runs (launcher-running.json in the data folder, src/launcher/desktop.ts), such as
//   "Pi Pocket (console)". Otherwise it starts one, `pi-pocket.js --desktop`, which listens on this PC only, and holds
//   its standard input: Quit, or the end of this app, closes it, and the launcher stops. The launcher and everything
//   it starts are in a job object that ends with this app, so nothing runs on after it.
// - The window signs in with a one-time link (POST /api/sign-in-link, with the owner's token from config.json as a
//   bearer token): the token is never on a command line, in a title, or in the log.
// - The window is Edge (msedge --app) with a profile of its own, in "Edge profile" beside this file. Without Edge, the
//   default browser opens the one-time link.
//
// The app is not updated from Pi Pocket's menu; a newer installer replaces it. It must keep working with newer
// pi-pocket packages: it uses only --desktop, launcher-running.json, /api/pocket/info, /api/sign-in-link, and
// /api/restart.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Pi Pocket")]
[assembly: AssemblyProduct("Pi Pocket")]
[assembly: AssemblyDescription("Pi Pocket")]
[assembly: AssemblyCompany("Tanner Middleton")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Tanner Middleton. MIT License.")]
[assembly: AssemblyVersion(PiPocket.Program.NumericVersion)]
[assembly: AssemblyFileVersion(PiPocket.Program.NumericVersion)]
[assembly: AssemblyInformationalVersion(PiPocket.Program.Version)]

namespace PiPocket
{
    static class Native
    {
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        public const int ASFW_ANY = -1;
        public const int SW_RESTORE = 9;

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("user32.dll")]
        public static extern bool AllowSetForegroundWindow(int processId);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll")]
        public static extern IntPtr GetWindow(IntPtr window, uint command);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc each, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);
    }

    static class Program
    {
        // build.ps1 puts the installer's version in place of these.
        public const string Version = "0.0.0-dev";
        public const string NumericVersion = "0.0.0.0";
        const string MutexName = @"Local\Pi Pocket desktop app";
        public const string OpenEventName = @"Local\Pi Pocket desktop app: open";
        public const string QuitEventName = @"Local\Pi Pocket desktop app: quit";

        [STAThread]
        static int Main(string[] args)
        {
            bool hidden = Array.IndexOf(args, "--hidden") >= 0;
            bool quit = Array.IndexOf(args, "--quit") >= 0;
            bool first;

            using (Mutex mutex = new Mutex(true, MutexName, out first))
            {
                if (quit)
                {
                    return first ? 0 : Signal(QuitEventName);
                }

                if (!first)
                {
                    // The running one opens its window. This process got the click, so it may hand the foreground on.
                    if (!hidden)
                    {
                        Native.AllowSetForegroundWindow(Native.ASFW_ANY);
                        Signal(OpenEventName);
                    }

                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                TrayApp app = new TrayApp(hidden);
                Application.Run(app);
                GC.KeepAlive(mutex);

                return 0;
            }
        }

        /// -1, 0, or 1, as SemVer orders the two versions; a pre-release comes before its release (the same order as
        /// CompareVersions in pi-pocket.iss).
        public static int CompareVersions(string a, string b)
        {
            string[] left = a.Split('+')[0].Split(new char[] { '-' }, 2);
            string[] right = b.Split('+')[0].Split(new char[] { '-' }, 2);
            string[] leftCore = left[0].Split('.');
            string[] rightCore = right[0].Split('.');

            for (int index = 0; index < 3; index++)
            {
                long x = index < leftCore.Length ? Number(leftCore[index]) : 0;
                long y = index < rightCore.Length ? Number(rightCore[index]) : 0;

                if (x != y)
                {
                    return x < y ? -1 : 1;
                }
            }

            if (left.Length == 1 || right.Length == 1)
            {
                return left.Length == right.Length ? 0 : (left.Length == 1 ? 1 : -1);
            }

            string[] leftPre = left[1].Split('.');
            string[] rightPre = right[1].Split('.');

            for (int index = 0; index < Math.Max(leftPre.Length, rightPre.Length); index++)
            {
                if (index >= leftPre.Length || index >= rightPre.Length)
                {
                    return index >= leftPre.Length ? -1 : 1;
                }

                string x = leftPre[index];
                string y = rightPre[index];
                int order = Digits(x) && Digits(y)
                    ? Number(x).CompareTo(Number(y))
                    : string.CompareOrdinal(x, y);

                if (order != 0)
                {
                    return order < 0 ? -1 : 1;
                }
            }

            return 0;
        }

        static bool Digits(string text)
        {
            if (text.Length == 0)
            {
                return false;
            }

            foreach (char each in text)
            {
                if (each < '0' || each > '9')
                {
                    return false;
                }
            }

            return true;
        }

        static long Number(string text)
        {
            long value;

            return long.TryParse(text, System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out value) ? value : 0;
        }

        static int Signal(string name)
        {
            try
            {
                using (EventWaitHandle signal = EventWaitHandle.OpenExisting(name))
                {
                    signal.Set();
                }

                return 0;
            }
            catch (Exception)
            {
                // The other one is just starting or stopping.
                return 1;
            }
        }
    }

    sealed class TrayApp : ApplicationContext
    {
        readonly string appDir = Path.GetDirectoryName(Application.ExecutablePath);
        readonly string dataDir;
        readonly string logFile;
        readonly object logLock = new object();
        readonly NotifyIcon tray = new NotifyIcon();
        readonly ToolStripMenuItem openItem = new ToolStripMenuItem("Open Pi Pocket");
        readonly ToolStripMenuItem restartItem = new ToolStripMenuItem("Restart server");
        readonly ToolStripMenuItem quitItem = new ToolStripMenuItem("Quit Pi Pocket");
        readonly Control ui = new Control();
        readonly EventWaitHandle openEvent;
        readonly EventWaitHandle quitEvent;
        IntPtr job = IntPtr.Zero;
        StreamWriter log;
        Process launcher;
        Process edge;
        string url;
        bool ready;
        bool openWhenReady;
        bool quitting;

        public TrayApp(bool hidden)
        {
            string data = Environment.GetEnvironmentVariable("PI_POCKET_DIR");
            dataDir = string.IsNullOrEmpty(data)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pi-pocket")
                : Path.GetFullPath(data);
            logFile = Path.Combine(appDir, "launcher.log");
            openWhenReady = !hidden;
            // The handle that BeginInvoke needs, made on this thread.
            ui.CreateControl();
            GC.KeepAlive(ui.Handle);

            string icon = Path.Combine(appDir, "pi-pocket.ico");
            tray.Icon = File.Exists(icon)
                ? new Icon(icon, SystemInformation.SmallIconSize)
                : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            tray.Text = "Pi Pocket (starting)";
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            openItem.Enabled = false;
            restartItem.Enabled = false;
            openItem.Click += delegate { OpenWindow(); };
            restartItem.Click += delegate { Restart(); };
            quitItem.Click += delegate { Quit(); };
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add(openItem);
            menu.Items.Add(restartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quitItem);
            tray.ContextMenuStrip = menu;
            tray.MouseClick += delegate (object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left)
                {
                    OpenWindow();
                }
            };
            tray.Visible = true;

            openEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.OpenEventName);
            quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.QuitEventName);
            Thread listener = new Thread(delegate ()
            {
                for (;;)
                {
                    if (WaitHandle.WaitAny(new WaitHandle[] { openEvent, quitEvent }) == 0)
                    {
                        OnUi(delegate { OpenWindow(); });
                    }
                    else
                    {
                        OnUi(delegate { Quit(); });
                    }
                }
            });
            listener.IsBackground = true;
            listener.Start();

            Thread start = new Thread(Start);
            start.IsBackground = true;
            start.Start();
        }

        void OnUi(MethodInvoker action)
        {
            try
            {
                ui.BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // The app is closing.
            }
        }

        void Log(string line)
        {
            lock (logLock)
            {
                if (log != null)
                {
                    log.WriteLine(line);
                }
            }
        }

        // ─── The server ─────────────────────────────────────────────────

        void Start()
        {
            try
            {
                OpenLog();
                string running = RunningUrl(-1);

                if (running != null)
                {
                    // Another launcher runs it, such as Pi Pocket (console): use it, and leave it running on Quit.
                    url = running;
                    OnUi(delegate { Ready(); });

                    return;
                }

                string[] problem = PackageProblem();

                if (problem != null)
                {
                    OnUi(delegate { Fail(problem[0], problem[1]); });

                    return;
                }

                StartLauncher();
                Stopwatch waited = Stopwatch.StartNew();

                // An update that does not start can take the launcher 5 minutes to undo.
                while (waited.Elapsed.TotalMinutes < 6)
                {
                    if (launcher.HasExited)
                    {
                        return;
                    }

                    running = RunningUrl(launcher.Id);

                    if (running != null)
                    {
                        url = running;
                        OnUi(delegate { Ready(); });

                        return;
                    }

                    Thread.Sleep(250);
                }

                OnUi(delegate { Fail("Pi Pocket did not get ready in 6 minutes."); });
            }
            catch (Exception error)
            {
                OnUi(delegate { Fail("Pi Pocket could not start: " + error.Message); });
            }
        }

        /// The address of a running launcher's server that answers, from launcher-running.json; for pid -1, any
        /// launcher's.
        string RunningUrl(int pid)
        {
            string file = Path.Combine(dataDir, "launcher-running.json");

            if (!File.Exists(file))
            {
                return null;
            }

            Dictionary<string, object> running;

            try
            {
                running = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
            }
            catch (Exception)
            {
                return null;
            }

            object value;
            int found = running.TryGetValue("pid", out value) && value is int ? (int)value : 0;
            string address = running.TryGetValue("url", out value) ? value as string : null;

            if (found == 0 || address == null || (pid != -1 && found != pid))
            {
                return null;
            }

            try
            {
                using (Process process = Process.GetProcessById(found))
                {
                    if (process.HasExited)
                    {
                        return null;
                    }
                }
            }
            catch (Exception)
            {
                // Gone, or the number is another user's process now: the check below decides either way.
                return null;
            }

            try
            {
                string info = Request("GET", address + "/api/pocket/info", null);

                return info.Contains("\"pi-pocket\"") ? address : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// launcher.log beside this file, with the last run's in launcher.old.log. It has no token or sign-in link.
        void OpenLog()
        {
            try
            {
                if (File.Exists(logFile))
                {
                    File.Copy(logFile, Path.Combine(appDir, "launcher.old.log"), true);
                }
            }
            catch (IOException)
            {
                // The new log matters more than the old one.
            }

            StreamWriter writer = new StreamWriter(logFile, false, new UTF8Encoding(false));
            writer.AutoFlush = true;

            lock (logLock)
            {
                log = writer;
            }

            Log("Pi Pocket desktop app " + Program.Version + ", " + DateTime.Now.ToString("u"));
        }

        /// What is wrong with the pi-pocket package that Setup put in app\, as a title and what to do; null when nothing
        /// is. Setup writes app\setup-finished.txt after it copied the package: without it, the copy stopped. A package
        /// older than this app is one that Setup did not replace: an older launcher refuses --desktop, so it
        /// must not start. A newer one is an in-app update, and stays.
        string[] PackageProblem()
        {
            string folder = Path.Combine(appDir, @"app\node_modules\pi-pocket");
            string again = "Run Pi Pocket Setup " + Program.Version + " again. Your sessions and settings stay.";
            string version = null;

            try
            {
                if (File.Exists(Path.Combine(folder, @"bin\pi-pocket.js")))
                {
                    Dictionary<string, object> manifest = new JavaScriptSerializer()
                        .Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(folder, "package.json")));
                    object value;
                    version = manifest.TryGetValue("version", out value) ? value as string : null;
                }
            }
            catch (Exception)
            {
                version = null;
            }

            if (version == null || !File.Exists(Path.Combine(appDir, @"app\setup-finished.txt")))
            {
                return new string[]
                {
                    "Pi Pocket is not fully installed: Setup did not finish putting the pi-pocket package in " +
                        folder + ".",
                    again
                };
            }

            if (!string.Equals(Program.Version, "0.0.0-dev") && Program.CompareVersions(version, Program.Version) < 0)
            {
                return new string[]
                {
                    "The pi-pocket package of Pi Pocket is version " + version + ", older than this app (" +
                        Program.Version + ").",
                    "Setup did not finish putting the package in place, so Pi Pocket cannot start. " + again
                };
            }

            return null;
        }

        void StartLauncher()
        {
            string node = Path.Combine(appDir, @"node\node.exe");
            string script = Path.Combine(appDir, @"app\node_modules\pi-pocket\bin\pi-pocket.js");

            if (!File.Exists(node) || !File.Exists(script))
            {
                throw new FileNotFoundException("Pi Pocket is not fully installed. Run Setup again.", script);
            }

            // What pi-pocket.cmd sets, for the console entry.
            ProcessStartInfo start = new ProcessStartInfo(node, Quote(script) + " --desktop --data " + Quote(dataDir));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.StandardErrorEncoding = Encoding.UTF8;
            start.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            start.EnvironmentVariables["NPM_CONFIG_PREFIX"] = Path.Combine(appDir, "app");
            start.EnvironmentVariables["NPM_CONFIG_CACHE"] = Path.Combine(appDir, "npm-cache");
            start.EnvironmentVariables["NPM_CONFIG_UPDATE_NOTIFIER"] = "false";
            start.EnvironmentVariables["NO_COLOR"] = "1";
            start.EnvironmentVariables["PATH"] = Path.Combine(appDir, "node") + ";" + Path.Combine(appDir, "app") + ";" +
                start.EnvironmentVariables["PATH"];

            launcher = new Process();
            launcher.StartInfo = start;
            launcher.EnableRaisingEvents = true;
            launcher.OutputDataReceived += delegate (object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null)
                {
                    Log(e.Data);
                }
            };
            launcher.ErrorDataReceived += delegate (object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null)
                {
                    Log(e.Data);
                }
            };
            launcher.Exited += delegate { OnUi(LauncherExited); };
            launcher.Start();
            // At once, before the launcher starts the server: the server and every command that it runs join the job.
            AddToJob(launcher);
            launcher.BeginOutputReadLine();
            launcher.BeginErrorReadLine();
        }

        /// A job that ends every process in it when this app ends, also when it crashes or is killed. This app is not in
        /// it, so the default browser that it may open stays.
        void AddToJob(Process process)
        {
            if (job == IntPtr.Zero)
            {
                job = Native.CreateJobObject(IntPtr.Zero, null);

                if (job == IntPtr.Zero)
                {
                    throw new Win32Exception();
                }

                Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref info,
                    Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                {
                    throw new Win32Exception();
                }
            }

            if (!Native.AssignProcessToJobObject(job, process.Handle))
            {
                Log("Could not add process " + process.Id + " to the job: " + new Win32Exception().Message);
            }
        }

        void Ready()
        {
            ready = true;
            tray.Text = launcher == null ? "Pi Pocket (started by another launcher)" : "Pi Pocket";
            openItem.Enabled = true;
            restartItem.Enabled = true;

            if (openWhenReady)
            {
                OpenWindow();
            }
        }

        void LauncherExited()
        {
            if (quitting)
            {
                return;
            }

            int code = launcher.ExitCode;

            if (code == 0)
            {
                Exit();

                return;
            }

            Fail((ready ? "Pi Pocket stopped" : "Pi Pocket could not start") + " (exit code " + code + ").");
        }

        void Fail(string message)
        {
            Fail(message, launcher == null ? null : "The details are in " + logFile);
        }

        void Fail(string message, string advice)
        {
            if (quitting)
            {
                return;
            }

            quitting = true;
            tray.Visible = false;
            Log("Error: " + message + (advice == null ? "" : " " + advice));
            MessageBox.Show(message + (advice == null ? "" : "\r\n\r\n" + advice), "Pi Pocket", MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Stop();
        }

        void Restart()
        {
            try
            {
                Request("POST", url + "/api/restart", OwnerToken());
                tray.ShowBalloonTip(3000, "Pi Pocket", "The server restarts. Running work continues.", ToolTipIcon.Info);
            }
            catch (Exception error)
            {
                tray.ShowBalloonTip(5000, "Pi Pocket", "Could not restart the server: " + error.Message,
                    ToolTipIcon.Warning);
            }
        }

        void Quit()
        {
            if (quitting)
            {
                return;
            }

            quitting = true;
            tray.Visible = false;
            Stop();
        }

        /// Close the launcher's input, so that it stops its server and its tunnel; then end the job with this app.
        void Stop()
        {
            Thread stop = new Thread(delegate ()
            {
                try
                {
                    if (launcher != null && !launcher.HasExited)
                    {
                        launcher.StandardInput.Close();
                        launcher.WaitForExit(20000);
                    }
                }
                catch (Exception)
                {
                    // The job ends what is left.
                }

                OnUi(Exit);
            });
            stop.IsBackground = true;
            stop.Start();
        }

        void Exit()
        {
            tray.Visible = false;
            tray.Dispose();

            lock (logLock)
            {
                if (log != null)
                {
                    log.Dispose();
                    log = null;
                }
            }

            ExitThread();
        }

        // ─── The window ─────────────────────────────────────────────────

        void OpenWindow()
        {
            if (!ready)
            {
                openWhenReady = true;

                return;
            }

            if (FocusEdge())
            {
                return;
            }

            string target = url + "/";

            try
            {
                target = url + SignInPath();
            }
            catch (Exception error)
            {
                // The window opens on the sign-in page instead.
                Log("No one-time sign-in link: " + error.Message);
            }

            string msedge = FindEdge();

            if (msedge != null)
            {
                string profile = Path.Combine(appDir, "Edge profile");
                ProcessStartInfo start = new ProcessStartInfo(msedge, Quote("--app=" + target) + " " +
                    Quote("--user-data-dir=" + profile) + " --no-first-run --no-default-browser-check");
                start.UseShellExecute = false;

                try
                {
                    Process started = Process.Start(start);

                    // The window closes on Quit, with the server that it shows.
                    if (edge == null || edge.HasExited)
                    {
                        edge = started;
                        AddToJob(edge);
                    }

                    return;
                }
                catch (Exception error)
                {
                    Log("Could not start Edge: " + error.Message);
                }
            }

            OpenInDefaultBrowser(target);
        }

        /// Bring the Edge window that this app opened to the front, if it is still there.
        bool FocusEdge()
        {
            if (edge == null || edge.HasExited)
            {
                return false;
            }

            IntPtr found = IntPtr.Zero;
            int id = edge.Id;
            Native.EnumWindows(delegate (IntPtr window, IntPtr unused)
            {
                int owner;
                Native.GetWindowThreadProcessId(window, out owner);

                if (owner == id && Native.IsWindowVisible(window) && Native.GetWindow(window, 4) == IntPtr.Zero)
                {
                    found = window;

                    return false;
                }

                return true;
            }, IntPtr.Zero);

            if (found == IntPtr.Zero)
            {
                return false;
            }

            if (Native.IsIconic(found))
            {
                Native.ShowWindow(found, Native.SW_RESTORE);
            }

            Native.SetForegroundWindow(found);

            return true;
        }

        static string FindEdge()
        {
            string[] keys =
            {
                @"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
                @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
                @"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
            };

            foreach (string key in keys)
            {
                string path = Registry.GetValue(key, "", null) as string;

                if (!string.IsNullOrEmpty(path) && File.Exists(path.Trim('"')))
                {
                    return path.Trim('"');
                }
            }

            foreach (Environment.SpecialFolder folder in new[]
            {
                Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.ProgramFiles,
            })
            {
                string path = Path.Combine(Environment.GetFolderPath(folder), @"Microsoft\Edge\Application\msedge.exe");

                if (File.Exists(path))
                {
                    return path;
                }
            }

            return null;
        }

        /// The default browser, which is not in the job: it stays when Pi Pocket quits.
        void OpenInDefaultBrowser(string target)
        {
            try
            {
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            }
            catch (Exception error)
            {
                Log("Could not open the default browser: " + error.Message);
            }
        }

        // ─── Sign-in and HTTP ───────────────────────────────────────────

        /// The owner's token, from config.json in the data folder, which only this Windows account can read.
        string OwnerToken()
        {
            Dictionary<string, object> config = new JavaScriptSerializer()
                .Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(dataDir, "config.json")));
            object token;

            if (!config.TryGetValue("ownerToken", out token) || !(token is string))
            {
                throw new InvalidDataException("config.json has no owner token");
            }

            return (string)token;
        }

        string SignInPath()
        {
            string answer = Request("POST", url + "/api/sign-in-link", OwnerToken());
            Dictionary<string, object> link = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(answer);
            object path;

            if (!link.TryGetValue("path", out path) || !(path is string) || !((string)path).StartsWith("/login?"))
            {
                throw new InvalidDataException("The server gave no sign-in link");
            }

            return (string)path;
        }

        /// A request to the server on this PC, never through a proxy. The token goes in a header, never in the log.
        static string Request(string method, string address, string token)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(address);
            request.Method = method;
            request.Proxy = null;
            request.Timeout = 10000;
            request.ReadWriteTimeout = 10000;
            request.AllowAutoRedirect = false;

            if (token != null)
            {
                request.Headers["Authorization"] = "Bearer " + token;
            }

            if (method != "GET")
            {
                request.Headers["X-Pocket"] = "1";
                request.ContentType = "application/json";
                byte[] body = Encoding.UTF8.GetBytes("{}");
                request.ContentLength = body.Length;

                using (Stream stream = request.GetRequestStream())
                {
                    stream.Write(body, 0, body.Length);
                }
            }

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        /// One argument for a Windows command line, as CommandLineToArgvW reads it.
        static string Quote(string argument)
        {
            StringBuilder quoted = new StringBuilder("\"");
            int slashes = 0;

            foreach (char each in argument)
            {
                if (each == '\\')
                {
                    slashes++;

                    continue;
                }

                quoted.Append('\\', each == '"' ? slashes * 2 + 1 : slashes);
                slashes = 0;
                quoted.Append(each);
            }

            quoted.Append('\\', slashes * 2);

            return quoted.Append('"').ToString();
        }
    }
}
