using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Hakobi.ClickOnce;

internal static class Program
{
    [STAThread]
    private static int Main(string[] arguments)
    {
        string executable = Path.Combine(AppContext.BaseDirectory, "payload", "HAKOBI.exe");
        if (!File.Exists(executable))
            return Fail("HAKOBI 本体が見つかりません。配布ファイルが不足しています。\n配布担当者に連絡し、ClickOnce 版を再インストールしてください。");

        try
        {
            using Process child = StartElectron(executable, arguments);
            child.WaitForExit();
            // Electron の再起動や二重起動の転送でも、その配布フォルダーの本体が終わるまで残る。
            // ClickOnce に利用中の配布として認識させ、更新中の削除を避ける。
            RunningHakobi.WaitUntilDeploymentExits(executable);
            return child.ExitCode;
        }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            return Fail($"HAKOBI を起動できませんでした。\n{error.Message}\n\n続く場合は、配布担当者に連絡してください。");
        }
    }

    private static Process StartElectron(string executable, string[] arguments)
    {
        // 別バージョンのランチャーを同時に開いても、確認と起動の間に割り込ませない。
        using var identity = WindowsIdentity.GetCurrent();
        using var gate = new Mutex(false, @"Local\HAKOBI.ClickOnce.Start." + identity.User!.Value);
        bool acquired;
        try { acquired = gate.WaitOne(TimeSpan.FromSeconds(15)); }
        catch (AbandonedMutexException) { acquired = true; }
        if (!acquired) throw new InvalidOperationException("別の HAKOBI が起動処理中です。少し待ってから起動し直してください。");
        try
        {
            if (RunningHakobi.PathsForCurrentUser().Any(path => LauncherPolicy.IsForeignDeployment(executable, path)))
                throw new InvalidOperationException("別の版の HAKOBI が起動しています。\nタスクトレイの HAKOBI から「終了」を選び、すべて終了してから起動し直してください。\n旧インストーラー版も終了してください。");

            string version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0.0";
            var start = LauncherPolicy.CreateStartInfo(executable, Environment.ProcessPath!, version, arguments);
            return Process.Start(start) ?? throw new InvalidOperationException("HAKOBI を起動できませんでした。");
        }
        finally { gate.ReleaseMutex(); }
    }

    private static int Fail(string message)
    {
        MessageBoxW(IntPtr.Zero, message, "HAKOBI", 0x00000010);
        return 1;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);
}
