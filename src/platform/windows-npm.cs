using System;
using System.Runtime.InteropServices;
using System.Text;

static class WindowsNpm {
    const string JobPrefix = @"Local\StackForge.Npm.";
    const uint KillOnClose = 0x2000;
    const uint JobTerminate = 0x0008;
    const uint ExtendedStartupInfo = 0x00080000;
    const uint CreateNoWindow = 0x08000000;
    const uint UseStandardHandles = 0x0100;
    const uint SameAccess = 2;
    const int AttributeHandleList = 0x00020002;
    const int AttributeJobList = 0x0002000D;

    static int Main(string[] args) {
        Guid id;
        if (args.Length < 2 || !args[1].StartsWith(JobPrefix, StringComparison.Ordinal) ||
            !Guid.TryParseExact(args[1].Substring(JobPrefix.Length), "D", out id)) return 1;
        try {
            if (args[0] == "cancel" && args.Length == 2) return Cancel(args[1]);
            if (args[0] == "run" && args.Length >= 3) return Run(args);
            return 1;
        } catch (InvalidOperationException error) {
            Console.Error.WriteLine("Windows npm process supervision failed: " + error.Message);
            return 1;
        }
    }

    static int Cancel(string name) {
        IntPtr job = OpenJobObject(JobTerminate, false, name);
        if (job == IntPtr.Zero) {
            int code = Marshal.GetLastWin32Error();
            if (code == 2) return 0;
            throw Failure("OpenJobObject", code);
        }
        try {
            Check(TerminateJobObject(job, 1), "TerminateJobObject");
            return 0;
        } finally { CloseHandle(job); }
    }

    static int Run(string[] args) {
        IntPtr job = CreateJobObject(IntPtr.Zero, args[1]);
        int creationCode = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero) throw Failure("CreateJobObject", creationCode);
        try {
            if (creationCode == 183) throw Failure("CreateJobObject", creationCode);
            SetKillOnClose(job, KillOnClose);
            ProcessInformation child = Launch(job, args);
            CloseHandle(child.Thread);
            try {
                Check(WaitForSingleObject(child.Process, UInt32.MaxValue) == 0, "WaitForSingleObject");
                uint code;
                Check(GetExitCodeProcess(child.Process, out code), "GetExitCodeProcess");
                // Keep normal npm completion compatible with commands that launch an independent process.
                // A still-draining invocation remains cancellable through the named job.
                SetKillOnClose(job, 0);
                return unchecked((int)code);
            } finally { CloseHandle(child.Process); }
        } finally { CloseHandle(job); }
    }

    static ProcessInformation Launch(IntPtr job, string[] args) {
        IntPtr bytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
        if (bytes == IntPtr.Zero) throw Failure("InitializeProcThreadAttributeList", Marshal.GetLastWin32Error());
        IntPtr attributes = Marshal.AllocHGlobal(bytes);
        IntPtr jobList = IntPtr.Zero, handleList = IntPtr.Zero;
        var handles = new IntPtr[3];
        bool initialized = false;
        try {
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes), "InitializeProcThreadAttributeList");
            initialized = true;
            IntPtr self = GetCurrentProcess();
            for (int index = 0; index < handles.Length; index++) {
                Check(DuplicateHandle(self, GetStdHandle(-10 - index), self, out handles[index], 0, true, SameAccess),
                    "DuplicateHandle");
            }
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            handleList = Marshal.AllocHGlobal(handles.Length * IntPtr.Size);
            Marshal.Copy(handles, 0, handleList, handles.Length);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(AttributeJobList), jobList,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute job list");
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(AttributeHandleList), handleList,
                new IntPtr(handles.Length * IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute handle list");
            var startup = new StartupInfoEx {
                Info = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfoEx)), Flags = UseStandardHandles,
                    Input = handles[0], Output = handles[1], Error = handles[2] }, Attributes = attributes
            };
            var commandLine = new StringBuilder();
            for (int index = 2; index < args.Length; index++) {
                if (index > 2) commandLine.Append(' ');
                Quote(commandLine, args[index]);
            }
            ProcessInformation child;
            Check(CreateProcess(args[2], commandLine, IntPtr.Zero, IntPtr.Zero, true, ExtendedStartupInfo | CreateNoWindow,
                IntPtr.Zero, null, ref startup, out child), "CreateProcess");
            return child;
        } finally {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            foreach (IntPtr handle in handles) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }

    // Escape backslashes before quotes, including the closing quote, for Windows argv parsing.
    static void Quote(StringBuilder command, string arg) {
        command.Append('"');
        int slashes = 0;
        foreach (char character in arg) {
            if (character == '\\') { slashes++; continue; }
            command.Append('\\', character == '"' ? 2 * slashes + 1 : slashes);
            command.Append(character);
            slashes = 0;
        }
        command.Append('\\', 2 * slashes).Append('"');
    }

    static void SetKillOnClose(IntPtr job, uint flags) {
        var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = flags } };
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "SetInformationJobObject");
    }

    static void Check(bool success, string operation) {
        if (!success) throw Failure(operation, Marshal.GetLastWin32Error());
    }

    static InvalidOperationException Failure(string operation, int code) {
        return new InvalidOperationException(operation + " (Win32 error " + code + ")");
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBuffer, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }

    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", EntryPoint = "OpenJobObjectW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr key, IntPtr value, IntPtr size,
        IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target,
        uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
}
