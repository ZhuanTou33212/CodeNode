// winjob.exe —— Windows Job Object 沙箱代理（CodeNode 执行隔离后端）
//
// 设计要点：
//   1. 本进程先把「自己」加入一个 Job Object，再启动目标命令；Windows 的 job 成员资格
//      会被子进程自动继承，于是目标命令及其所有后代都在同一个 job 内 —— 这是内核级包含，
//      不是靠 taskkill 事后追杀的尽力而为。
//   2. 设置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：本进程结束（含被强杀、父进程崩溃后管道断开）
//      时内核立即终止 job 内全部进程，杜绝孤儿进程与残留副作用。
//   3. 可选上限：ACTIVE_PROCESS（进程数）、JOB_MEMORY（job 总内存）、JOB_TIME（CPU 时间）。
//   4. 无 JSON 依赖之外的系统调用；stdout 逐行输出 JSON，二进制内容一律 base64，避免编码问题。
//
// 协议（stdin/stdout 逐行 JSON）：
//   node → exe : 命令行 -spec <spec.json>；stdin 关闭 = 请求终止（子进程树一并终止）
//   exe → node : {"ev":"started","pid":N} | {"ev":"out","stream":"stdout|stderr","b64":"..."}
//                | {"ev":"exit","code":N,"killed":bool} | {"ev":"error","message":"..."} | {"ev":"probe",...}
//
// spec.json:
//   { "file": "node", "args": ["-e","..."], "cwd": "E:\\proj", "env": {...},
//     "limits": { "maxProcesses": 8, "maxMemoryMB": 512, "cpuSeconds": 60, "brokerReserveMB": 160 } }
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class WinJob
{
    // ---- Win32 ----
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private const uint JOB_OBJECT_LIMIT_WORKINGSET = 0x1;
    private const uint JOB_OBJECT_LIMIT_JOB_TIME = 0x4;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
    private const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;

    private static readonly object OutGate = new object();
    private static IntPtr _job = IntPtr.Zero;
    private static Process _child;
    private static bool _killed;

    private static void Emit(string json)
    {
        lock (OutGate)
        {
            try
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
            catch { }
        }
    }

    private static string Esc(string value)
    {
        var sb = new StringBuilder();
        foreach (char c in value ?? string.Empty)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    private static void Fail(string message, int code)
    {
        Emit("{\"ev\":\"error\",\"message\":\"" + Esc(message) + "\",\"code\":" + code + "}");
        Environment.Exit(code);
    }

    /// <summary>Windows 命令行参数转义（CommandLineToArgvW 规则）。</summary>
    private static string Quote(string arg)
    {
        if (arg == null) return "\"\"";
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        var sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\')
            {
                backslashes++;
                sb.Append(c);
            }
            else if (c == '"')
            {
                sb.Append('\\', backslashes + 1);
                sb.Append('"');
                backslashes = 0;
            }
            else
            {
                backslashes = 0;
                sb.Append(c);
            }
        }
        sb.Append('\\', backslashes);
        sb.Append('"');
        return sb.ToString();
    }

    private static void Terminate()
    {
        if (_killed) return;
        _killed = true;
        try
        {
            if (_job != IntPtr.Zero) TerminateJobObject(_job, 1);
        }
        catch { }
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--probe")
            {
                Emit("{\"ev\":\"probe\",\"backend\":\"windows-job\",\"ok\":true,\"clr\":\"" + Esc(Environment.Version.ToString()) + "\"}");
                return 0;
            }
        }
        string specPath = null;
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == "-spec") specPath = args[i + 1];
        if (specPath == null || !File.Exists(specPath)) Fail("missing or unreadable -spec file", 2);

        Dictionary<string, object> spec;
        try
        {
            spec = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(specPath, Encoding.UTF8));
        }
        catch (Exception e)
        {
            Fail("invalid spec: " + e.Message, 2);
            return 2;
        }
        if (spec == null) { Fail("empty spec", 2); return 2; }

        var limits = spec.ContainsKey("limits") && spec["limits"] is System.Collections.IDictionary
            ? (System.Collections.IDictionary)spec["limits"]
            : new Dictionary<string, object>();
        uint maxProcesses = ToUInt(limits, "maxProcesses");
        uint maxMemoryMB = ToUInt(limits, "maxMemoryMB");
        uint cpuSeconds = ToUInt(limits, "cpuSeconds");
        uint brokerReserveMB = ToUInt(limits, "brokerReserveMB");
        if (brokerReserveMB == 0) brokerReserveMB = 160;

        _job = CreateJobObject(IntPtr.Zero, null);
        if (_job == IntPtr.Zero) { Fail("CreateJobObject failed err=" + Marshal.GetLastWin32Error(), 3); return 3; }

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        uint flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // 进程数上限：目标命令自己也算 1，broker 也算 1
        if (maxProcesses > 0)
        {
            flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = maxProcesses + 2;
        }
        if (maxMemoryMB > 0)
        {
            flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.JobMemoryLimit = (UIntPtr)((ulong)(maxMemoryMB + brokerReserveMB) * 1024UL * 1024UL);
        }
        if (cpuSeconds > 0)
        {
            flags |= JOB_OBJECT_LIMIT_JOB_TIME;
            info.BasicLimitInformation.PerJobUserTimeLimit = cpuSeconds * 10000000L;
        }
        info.BasicLimitInformation.LimitFlags = flags;

        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(_job, JobObjectExtendedLimitInformation, ptr, (uint)size))
            {
                Fail("SetInformationJobObject failed err=" + Marshal.GetLastWin32Error(), 3);
                return 3;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }

        // 关键：把 broker 自己放进 job。此后启动的所有进程自动继承 job 成员资格。
        if (!AssignProcessToJobObject(_job, GetCurrentProcess()))
        {
            Fail("AssignProcessToJobObject(broker) failed err=" + Marshal.GetLastWin32Error(), 3);
            return 3;
        }

        var psi = new ProcessStartInfo
        {
            FileName = Convert.ToString(spec.ContainsKey("file") ? spec["file"] : null),
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // 子进程必须拿到「立即 EOF」的 stdin：写成 false 时子进程继承 broker 的 stdin
            // （node 侧用于存活探测的长生命管道，永不关闭也不写数据），任何会读 stdin 的程序
            // 会永久阻塞且零输出、只能等超时强杀（实测 MSYS git.exe：git --version 挂满 60s）。
            // 该后端本就不支持交互式 stdin（guardedInteractiveSpawn 走别的路径），故直接关闭。
            RedirectStandardInput = true,
            CreateNoWindow = true,
            WorkingDirectory = Convert.ToString(spec.ContainsKey("cwd") ? spec["cwd"] : Directory.GetCurrentDirectory()),
        };
        if (psi.WorkingDirectory == null || psi.WorkingDirectory.Length == 0) psi.WorkingDirectory = Directory.GetCurrentDirectory();
        var argList = new List<string>();
        if (spec.ContainsKey("args") && spec["args"] is System.Collections.IEnumerable)
        {
            foreach (object a in (System.Collections.IEnumerable)spec["args"]) argList.Add(Convert.ToString(a));
        }
        psi.Arguments = string.Join(" ", argList.ConvertAll(Quote).ToArray());
        if (spec.ContainsKey("env") && spec["env"] is System.Collections.IDictionary)
        {
            psi.EnvironmentVariables.Clear();
            foreach (System.Collections.DictionaryEntry kv in (System.Collections.IDictionary)spec["env"])
            {
                if (kv.Key != null) psi.EnvironmentVariables[Convert.ToString(kv.Key)] = Convert.ToString(kv.Value);
            }
        }

        try
        {
            _child = Process.Start(psi);
        }
        catch (Exception e)
        {
            Fail("spawn failed: " + e.Message, 4);
            return 4;
        }
        if (_child == null) { Fail("spawn returned null", 4); return 4; }
        try { _child.StandardInput.Close(); } catch { }

        Emit("{\"ev\":\"started\",\"pid\":" + _child.Id + "}");

        // 父进程（node）stdin EOF 或收到任意指令 = 要求终止 → 结束 job
        var watch = new Thread(() =>
        {
            try
            {
                while (true)
                {
                    string line = Console.In.ReadLine();
                    if (line == null) break; // EOF：node 已退出/管道断开
                }
            }
            catch { }
            Terminate();
            Environment.Exit(0);
        });
        watch.IsBackground = true;
        watch.Start();

        var pumps = new[]
        {
            new Thread(() => Pump(_child.StandardOutput.BaseStream, "stdout")),
            new Thread(() => Pump(_child.StandardError.BaseStream, "stderr")),
        };
        foreach (var t in pumps) { t.IsBackground = true; t.Start(); }

        _child.WaitForExit();
        foreach (var t in pumps) t.Join(2000);
        int code = _child.ExitCode;
        Emit("{\"ev\":\"exit\",\"code\":" + code + ",\"killed\":" + (_killed ? "true" : "false") + "}");
        // 关闭 job 句柄 → KILL_ON_JOB_CLOSE 生效，任何漏网的子孙进程由内核清理
        if (_job != IntPtr.Zero) CloseHandle(_job);
        return code;
    }

    private static void Pump(Stream stream, string name)
    {
        var buffer = new byte[8192];
        try
        {
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                Emit("{\"ev\":\"out\",\"stream\":\"" + name + "\",\"b64\":\"" + Convert.ToBase64String(buffer, 0, read) + "\"}");
            }
        }
        catch { }
    }

    private static uint ToUInt(System.Collections.IDictionary source, string key)
    {
        if (source == null || !source.Contains(key) || source[key] == null) return 0;
        try
        {
            return Convert.ToUInt32(source[key], CultureInfo.InvariantCulture);
        }
        catch { return 0; }
    }
}
