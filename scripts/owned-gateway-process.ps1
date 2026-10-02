$ErrorActionPreference = 'Stop'

if (-not ('GatewayContainment.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace GatewayContainment {
  public sealed class JobOwner : IDisposable {
    private IntPtr handle;

    internal IntPtr Handle {
      get { return handle; }
    }

    internal JobOwner(IntPtr value) {
      handle = value;
    }

    ~JobOwner() {
      Dispose(false);
    }

    public void Dispose() {
      Dispose(true);
      GC.SuppressFinalize(this);
    }

    private void Dispose(bool disposing) {
      IntPtr value = handle;
      handle = IntPtr.Zero;
      if (value != IntPtr.Zero && value != new IntPtr(-1)) {
        Native.CloseHandle(value);
      }
    }
  }

  public sealed class LaunchResult {
    public Process Process;
    public JobOwner Job;
  }

  public static class Native {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const short SW_HIDE = 0;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x00020002;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint CREATE_ALWAYS = 2;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES {
      public int nLength;
      public IntPtr lpSecurityDescriptor;
      [MarshalAs(UnmanagedType.Bool)]
      public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
      public int cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public int dwX;
      public int dwY;
      public int dwXSize;
      public int dwYSize;
      public int dwXCountChars;
      public int dwYCountChars;
      public int dwFillAttribute;
      public int dwFlags;
      public short wShowWindow;
      public short cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX {
      public STARTUPINFO StartupInfo;
      public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public int dwProcessId;
      public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public IntPtr MinimumWorkingSetSize;
      public IntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public IntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public IntPtr ProcessMemoryLimit;
      public IntPtr JobMemoryLimit;
      public IntPtr PeakProcessMemoryUsed;
      public IntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
      IntPtr hJob,
      int JobObjectInfoClass,
      ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo,
      uint cbJobObjectInfoLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
      IntPtr hJob,
      int JobObjectInfoClass,
      ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo,
      uint cbJobObjectInfoLength,
      IntPtr lpReturnLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr hObject, out uint lpdwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr ProcessHandle, IntPtr JobHandle, [MarshalAs(UnmanagedType.Bool)] out bool Result);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
      string lpApplicationName,
      StringBuilder lpCommandLine,
      IntPtr lpProcessAttributes,
      IntPtr lpThreadAttributes,
      [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
      uint dwCreationFlags,
      IntPtr lpEnvironment,
      string lpCurrentDirectory,
      ref STARTUPINFOEX lpStartupInfo,
      out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFile(
      string lpFileName,
      uint dwDesiredAccess,
      uint dwShareMode,
      ref SECURITY_ATTRIBUTES lpSecurityAttributes,
      uint dwCreationDisposition,
      uint dwFlagsAndAttributes,
      IntPtr hTemplateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
      IntPtr lpAttributeList,
      int dwAttributeCount,
      int dwFlags,
      ref IntPtr lpSize
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
      IntPtr lpAttributeList,
      uint dwFlags,
      IntPtr Attribute,
      IntPtr lpValue,
      IntPtr cbSize,
      IntPtr lpPreviousValue,
      IntPtr lpReturnSize
    );

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr hObject);

    private static void ThrowLastError(string action) {
      int error = Marshal.GetLastWin32Error();
      throw new Win32Exception(error, action + " (Win32 error " + error + ")");
    }

    private static void CloseIfValid(IntPtr handle) {
      if (handle != IntPtr.Zero && handle != INVALID_HANDLE_VALUE) {
        CloseHandle(handle);
      }
    }

    private static IntPtr OpenInheritableFile(string path, uint access, uint disposition) {
      SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
      attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
      attributes.bInheritHandle = true;
      IntPtr handle = CreateFile(
        path,
        access,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        ref attributes,
        disposition,
        FILE_ATTRIBUTE_NORMAL,
        IntPtr.Zero
      );
      if (handle == INVALID_HANDLE_VALUE) {
        ThrowLastError("CreateFileW failed for " + path);
      }
      return handle;
    }

    private static JobOwner CreateKillOnCloseJob() {
      IntPtr handle = CreateJobObject(IntPtr.Zero, null);
      if (handle == IntPtr.Zero) {
        ThrowLastError("CreateJobObjectW failed");
      }
      try {
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)) {
          ThrowLastError("SetHandleInformation failed for job handle");
        }
        uint handleFlags;
        if (!GetHandleInformation(handle, out handleFlags)) {
          ThrowLastError("GetHandleInformation failed for job handle");
        }
        if ((handleFlags & HANDLE_FLAG_INHERIT) != 0) {
          throw new InvalidOperationException("Job handle is inheritable");
        }

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, ref limits, size)) {
          ThrowLastError("SetInformationJobObject failed");
        }

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION readback = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        if (!QueryInformationJobObject(handle, JobObjectExtendedLimitInformation, ref readback, size, IntPtr.Zero)) {
          ThrowLastError("QueryInformationJobObject failed");
        }
        if ((readback.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) == 0) {
          throw new InvalidOperationException("Job does not have KILL_ON_JOB_CLOSE");
        }

        JobOwner owner = new JobOwner(handle);
        handle = IntPtr.Zero;
        return owner;
      } finally {
        CloseIfValid(handle);
      }
    }

    public static LaunchResult Launch(string filePath, string arguments, string workingDirectory, string stdoutPath, string stderrPath) {
      if (String.IsNullOrEmpty(filePath)) {
        throw new ArgumentException("FilePath is required", "filePath");
      }
      if (String.IsNullOrEmpty(workingDirectory)) {
        throw new ArgumentException("WorkingDirectory is required", "workingDirectory");
      }
      if (String.IsNullOrEmpty(stdoutPath) || String.IsNullOrEmpty(stderrPath)) {
        throw new ArgumentException("StdoutPath and StderrPath are required");
      }

      JobOwner job = null;
      IntPtr stdin = IntPtr.Zero;
      IntPtr stdout = IntPtr.Zero;
      IntPtr stderr = IntPtr.Zero;
      IntPtr handleList = IntPtr.Zero;
      IntPtr attributeList = IntPtr.Zero;
      bool attributeListInitialized = false;
      PROCESS_INFORMATION processInformation = new PROCESS_INFORMATION();
      bool processCreated = false;
      try {
        job = CreateKillOnCloseJob();
        stdin = OpenInheritableFile("NUL", GENERIC_READ, OPEN_EXISTING);
        stdout = OpenInheritableFile(stdoutPath, GENERIC_WRITE, CREATE_ALWAYS);
        stderr = OpenInheritableFile(stderrPath, GENERIC_WRITE, CREATE_ALWAYS);

        handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
        Marshal.WriteIntPtr(handleList, 0 * IntPtr.Size, stdin);
        Marshal.WriteIntPtr(handleList, 1 * IntPtr.Size, stdout);
        Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, stderr);

        IntPtr attributeListSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
        if (attributeListSize == IntPtr.Zero) {
          ThrowLastError("InitializeProcThreadAttributeList size query failed");
        }
        attributeList = Marshal.AllocHGlobal(attributeListSize);
        if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize)) {
          ThrowLastError("InitializeProcThreadAttributeList failed");
        }
        attributeListInitialized = true;
        if (!UpdateProcThreadAttribute(
            attributeList,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            handleList,
            (IntPtr)(IntPtr.Size * 3),
            IntPtr.Zero,
            IntPtr.Zero
          )) {
          ThrowLastError("UpdateProcThreadAttribute for handle list failed");
        }

        STARTUPINFOEX startupInfo = new STARTUPINFOEX();
        startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        startupInfo.StartupInfo.dwFlags = (int)(STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES);
        startupInfo.StartupInfo.wShowWindow = SW_HIDE;
        startupInfo.StartupInfo.hStdInput = stdin;
        startupInfo.StartupInfo.hStdOutput = stdout;
        startupInfo.StartupInfo.hStdError = stderr;
        startupInfo.lpAttributeList = attributeList;

        string commandLine = "\"" + filePath + "\"";
        if (!String.IsNullOrEmpty(arguments)) {
          commandLine += " " + arguments;
        }
        StringBuilder mutableCommandLine = new StringBuilder(commandLine);
        if (!CreateProcess(
            filePath,
            mutableCommandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            true,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
            IntPtr.Zero,
            workingDirectory,
            ref startupInfo,
            out processInformation
          )) {
          ThrowLastError("CreateProcessW failed");
        }
        processCreated = true;

        if (!AssignProcessToJobObject(job.Handle, processInformation.hProcess)) {
          ThrowLastError("AssignProcessToJobObject failed");
        }
        bool inJob;
        if (!IsProcessInJob(processInformation.hProcess, job.Handle, out inJob)) {
          ThrowLastError("IsProcessInJob failed");
        }
        if (!inJob) {
          throw new InvalidOperationException("Created process was not assigned to its job");
        }

        if (ResumeThread(processInformation.hThread) == 0xFFFFFFFF) {
          ThrowLastError("ResumeThread failed");
        }

        Process managedProcess = Process.GetProcessById(processInformation.dwProcessId);
        LaunchResult result = new LaunchResult();
        result.Process = managedProcess;
        result.Job = job;
        job = null;
        return result;
      } finally {
        if (processCreated && job != null) {
          TerminateProcess(processInformation.hProcess, 1);
        }
        CloseIfValid(processInformation.hThread);
        CloseIfValid(processInformation.hProcess);
        if (attributeListInitialized) {
          DeleteProcThreadAttributeList(attributeList);
        }
        if (attributeList != IntPtr.Zero) {
          Marshal.FreeHGlobal(attributeList);
        }
        if (handleList != IntPtr.Zero) {
          Marshal.FreeHGlobal(handleList);
        }
        CloseIfValid(stderr);
        CloseIfValid(stdout);
        CloseIfValid(stdin);
        if (job != null) {
          job.Dispose();
        }
      }
    }

  }
}
'@ -Language CSharp
}

function Start-OwnedGatewayProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath
  )

  $resolvedFilePath = $FilePath
  if (-not [IO.Path]::IsPathRooted($resolvedFilePath)) {
    $command = Get-Command -Name $resolvedFilePath -CommandType Application -ErrorAction Stop
    $resolvedFilePath = $command.Source
  }
  $result = [GatewayContainment.Native]::Launch(
    $resolvedFilePath,
    ($ArgumentList -join ' '),
    [IO.Path]::GetFullPath($WorkingDirectory),
    [IO.Path]::GetFullPath($StdoutPath),
    [IO.Path]::GetFullPath($StderrPath)
  )
  [pscustomobject]@{
    Process = $result.Process
    Job = $result.Job
  }
}
