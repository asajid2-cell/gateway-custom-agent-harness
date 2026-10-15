param(
  # Set only when a durable leaf is being started through this helper (see
  # Start-BreakawayLeaf below). Dot-sourced - the way cc.ps1 loads this - both
  # default to off and the file only defines types and functions.
  [switch]$LeafLaunch,
  [string]$LeafSpec
)
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
    private const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800;
    private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    private const uint DETACHED_PROCESS = 0x00000008;
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
        // KILL_ON_JOB_CLOSE is the parent-death guarantee: when the launcher that
        // holds this job dies, everything still in it dies with it. BREAKAWAY_OK
        // is what lets a member leave on purpose - a process born into a job is
        // killed with it, and a durable leaf has to outlive the session that
        // started it. The flag only *permits* leaving: a child still lands in
        // this job unless it is created with CREATE_BREAKAWAY_FROM_JOB, and the
        // only spawner that asks for that is Start-BreakawayLeaf below. Tools,
        // subagents and the whole backend chain stay contained.
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
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
        if ((readback.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_BREAKAWAY_OK) == 0) {
          throw new InvalidOperationException("Job does not have BREAKAWAY_OK");
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

    // Start a process that leaves the caller's job object, and no other.
    //
    // A member has to outlive the session that started it, but a process born
    // into a KILL_ON_JOB_CLOSE job is killed with it. CREATE_BREAKAWAY_FROM_JOB
    // is the one flag that leaves a job, and node's spawn cannot ask for it, so
    // the member is created here instead. The environment is inherited from the
    // caller (unlike a WMI creation, whose child would inherit WmiPrvSE's), so
    // the member keeps the endpoint, token and model it was handed. No console is
    // given (DETACHED_PROCESS, exactly as the old detached spawn did) and the
    // standard handles are NUL, so nothing pops a terminal. The child is created
    // suspended and its escape is verified before it is resumed: if it somehow
    // landed in a job anyway, it is terminated and the launch fails closed
    // rather than leave a contained process claiming to be durable.
    public static int LaunchBreakaway(string filePath, string arguments, string workingDirectory) {
      if (String.IsNullOrEmpty(filePath)) {
        throw new ArgumentException("FilePath is required", "filePath");
      }
      if (String.IsNullOrEmpty(workingDirectory)) {
        throw new ArgumentException("WorkingDirectory is required", "workingDirectory");
      }

      IntPtr stdin = IntPtr.Zero;
      IntPtr stdout = IntPtr.Zero;
      IntPtr stderr = IntPtr.Zero;
      IntPtr handleList = IntPtr.Zero;
      IntPtr attributeList = IntPtr.Zero;
      bool attributeListInitialized = false;
      PROCESS_INFORMATION processInformation = new PROCESS_INFORMATION();
      bool processCreated = false;
      bool handed = false;
      try {
        stdin = OpenInheritableFile("NUL", GENERIC_READ, OPEN_EXISTING);
        stdout = OpenInheritableFile("NUL", GENERIC_WRITE, OPEN_EXISTING);
        stderr = OpenInheritableFile("NUL", GENERIC_WRITE, OPEN_EXISTING);

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
            CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
            IntPtr.Zero,
            workingDirectory,
            ref startupInfo,
            out processInformation
          )) {
          ThrowLastError("CreateProcessW (breakaway) failed");
        }
        processCreated = true;

        bool inJob;
        if (!IsProcessInJob(processInformation.hProcess, IntPtr.Zero, out inJob)) {
          ThrowLastError("IsProcessInJob failed");
        }
        if (inJob) {
          throw new InvalidOperationException("Breakaway process is still in a job");
        }

        if (ResumeThread(processInformation.hThread) == 0xFFFFFFFF) {
          ThrowLastError("ResumeThread failed");
        }

        handed = true;
        return processInformation.dwProcessId;
      } finally {
        if (processCreated && !handed) {
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

# Quote one argument the way CreateProcess expects it on Windows, so an
# argument with a space, a quote or a trailing backslash survives the join into
# the single command-line string the native launch takes.
function ConvertTo-CommandLineArgument {
  param([string]$Value)
  if ($Value -ne '' -and $Value -notmatch '[\s"]') {
    return $Value
  }
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes++
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append('\', ($backslashes * 2) + 1)
      [void]$builder.Append('"')
    }
    else {
      if ($backslashes -gt 0) { [void]$builder.Append('\', $backslashes) }
      [void]$builder.Append($character)
    }
    $backslashes = 0
  }
  if ($backslashes -gt 0) { [void]$builder.Append('\', $backslashes * 2) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

# Start a durable leaf outside the caller's job object and return its pid.
#
# This is the one spawner that asks to leave the job; everything else - tools,
# subagents, the backend chain - stays contained. Arguments arrive as an array so
# each is quoted here rather than by a shell, and the child inherits this
# process's environment, so the leaf keeps the endpoint/token/model it was
# handed.
function Start-BreakawayLeaf {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  $resolvedFilePath = $FilePath
  if (-not [IO.Path]::IsPathRooted($resolvedFilePath)) {
    $command = Get-Command -Name $resolvedFilePath -CommandType Application -ErrorAction Stop
    $resolvedFilePath = $command.Source
  }
  $arguments = ($ArgumentList | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' '
  return [GatewayContainment.Native]::LaunchBreakaway(
    $resolvedFilePath,
    $arguments,
    [IO.Path]::GetFullPath($WorkingDirectory)
  )
}

# Invoked as `-File owned-gateway-process.ps1 -LeafLaunch -LeafSpec <base64>`.
# The spec is a base64-encoded UTF-8 JSON { file, args, cwd }: base64 keeps the
# leaf's command line from being re-parsed by a shell on the way in. When the
# file is dot-sourced instead (cc.ps1, the tests), the switch is off and only the
# types and functions above are defined.
if ($LeafLaunch) {
  $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($LeafSpec)) | ConvertFrom-Json
  $leafPid = Start-BreakawayLeaf -FilePath $spec.file -ArgumentList @($spec.args) -WorkingDirectory $spec.cwd
  [Console]::Out.WriteLine($leafPid)
}
