using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Hakobi.ClickOnce;

internal static class RunningHakobi
{
    private const uint QueryLimitedInformation = 0x1000;
    private const uint TokenQuery = 0x0008;

    // 同じログオンセッション、同じ利用者の HAKOBI だけを見る。他人のプロセスには触れない。
    internal static IEnumerable<string?> PathsForCurrentUser()
    {
        int session = Process.GetCurrentProcess().SessionId;
        string? currentSid = WindowsIdentity.GetCurrent().User?.Value;
        foreach (Process process in Process.GetProcessesByName("HAKOBI"))
        {
            using (process)
            {
                string? path;
                try
                {
                    if (process.SessionId != session) continue;
                    using SafeProcessHandle handle = OpenProcess(QueryLimitedInformation, false, process.Id);
                    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (!OpenProcessToken(handle, TokenQuery, out SafeAccessTokenHandle token))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    using (token)
                    using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
                    {
                        if (identity.User?.Value != currentSid) continue;
                    }
                    var buffer = new StringBuilder(32768);
                    int length = buffer.Capacity;
                    if (!QueryFullProcessImageName(handle, 0, buffer, ref length))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    path = buffer.ToString();
                }
                catch (InvalidOperationException)
                {
                    continue; // 確認中に終了したプロセス。
                }
                catch (Win32Exception)
                {
                    if (HasExited(process)) continue;
                    // 昇格した旧版などで確認できない場合も、別の版へ黙って操作を転送しない。
                    path = null;
                }
                yield return path;
            }
        }
    }

    internal static void WaitUntilDeploymentExits(string executable)
    {
        // app.relaunch() は元の Electron が終了した後に次のプロセスを作る。
        // 一度空になっても、その起動待ちの間に ClickOnce ランチャーを終了させない。
        var emptyPeriod = Stopwatch.StartNew();
        while (true)
        {
            bool running = PathsForCurrentUser().Any(path => path is not null && !LauncherPolicy.IsForeignDeployment(executable, path));
            if (running) emptyPeriod.Restart();
            else if (emptyPeriod.Elapsed >= TimeSpan.FromSeconds(2)) return;
            Thread.Sleep(100);
        }
    }

    private static bool HasExited(Process process)
    {
        try { return process.HasExited; }
        catch (InvalidOperationException) { return true; }
        catch (Win32Exception) { return false; }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(SafeProcessHandle processHandle, uint desiredAccess, out SafeAccessTokenHandle tokenHandle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle processHandle, int flags, StringBuilder executableName, ref int size);
}
