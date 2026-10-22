using Hakobi.ClickOnce;
using System.Diagnostics;
using System.Text.Json;

int assertions = 0;
void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
    assertions++;
}

Check(LauncherPolicy.SafeArguments(["https://evil.invalid", "--inspect=9000", "--user-data-dir=C:\\other"]).Length == 0, "任意 URL/スイッチを拒否");
Check(LauncherPolicy.SafeArguments(["--hakobi-action=timer-start"]).Length == 0, "タスクなしの計測開始を拒否");
Check(LauncherPolicy.SafeArguments(["--hakobi-action=timer-start", "--hakobi-task=../../file"]).Length == 0, "不正なタスク ID を拒否");
Check(LauncherPolicy.SafeArguments(["--hakobi-action=timer-start", "--hakobi-task=task\n"]).Length == 0, "改行を含むタスク ID を拒否");
Check(LauncherPolicy.SafeArguments(["--hakobi-action=timer-start", "--hakobi-task=task-123"]).SequenceEqual(["--hakobi-action=timer-start", "--hakobi-task=task-123"]), "計測開始を転送");
Check(LauncherPolicy.SafeArguments(["--hakobi-action=main", "--hakobi-task=task-123", "--hakobi-action=quit"]).SequenceEqual(["--hakobi-action=main"]), "操作は最初の有効なものだけ");
Check(!LauncherPolicy.IsForeignDeployment(@"C:\app\payload\HAKOBI.exe", @"c:\APP\payload\HAKOBI.exe"), "Windows パスは大小文字を区別しない");
Check(LauncherPolicy.IsForeignDeployment(@"C:\version-2\payload\HAKOBI.exe", @"C:\version-1\payload\HAKOBI.exe"), "別版を検出");
Check(LauncherPolicy.IsForeignDeployment(@"C:\app\payload\HAKOBI.exe", null), "参照できない既存プロセスを安全側で扱う");

var start = LauncherPolicy.CreateStartInfo(@"C:\app with spaces\payload\HAKOBI.exe", @"C:\app with spaces\HAKOBI.ClickOnce.exe", "1.0.5.2", ["--inspect=9000", "--hakobi-action=main"]);
Check(!start.UseShellExecute, "shell を経由しない");
Check(start.WorkingDirectory == @"C:\app with spaces\payload", "本体を作業フォルダーにする");
Check(start.Environment["HAKOBI_DISTRIBUTION"] == "clickonce", "配布方式を渡す");
Check(start.Environment["HAKOBI_CLICKONCE_VERSION"] == "1.0.5.2", "発行バージョンを渡す");
Check(start.ArgumentList.SequenceEqual(["--hakobi-action=main"]), "安全な操作だけを ArgumentList で渡す");
Console.WriteLine($"Launcher tests passed ({assertions} assertions).");

if (args.Length == 2)
{
    // 実行中の利用者アプリには触れず、専用の一時フォルダーだけで実プロセスを検証する。
    if (RunningHakobi.PathsForCurrentUser().Any())
        throw new Exception("Lifecycle test requires all HAKOBI instances to be closed.");
    string launcherDirectory = Path.GetFullPath(args[0]);
    string payloadDirectory = Path.GetFullPath(args[1]);
    string sandbox = Path.Combine(Path.GetTempPath(), "hakobi-launcher-test-" + Guid.NewGuid());
    Directory.CreateDirectory(Path.Combine(sandbox, "payload"));
    foreach (string file in Directory.GetFiles(launcherDirectory)) File.Copy(file, Path.Combine(sandbox, Path.GetFileName(file)));
    foreach (string file in Directory.GetFiles(payloadDirectory)) File.Copy(file, Path.Combine(sandbox, "payload", Path.GetFileName(file)));
    string report = Path.Combine(sandbox, "report.json");
    string exit = Path.Combine(sandbox, "exit");
    var processes = new List<Process>();
    Process StartLauncher()
    {
        var info = new ProcessStartInfo(Path.Combine(sandbox, "HAKOBI.ClickOnce.exe")) { UseShellExecute = false, CreateNoWindow = true };
        info.ArgumentList.Add("--inspect=9000");
        info.ArgumentList.Add("--hakobi-action=main");
        info.Environment["HAKOBI_LAUNCHER_TEST_REPORT"] = report;
        info.Environment["HAKOBI_LAUNCHER_TEST_EXIT"] = exit;
        info.Environment["HAKOBI_LAUNCHER_TEST_MUTEX"] = @"Local\HAKOBI.Launcher.Test." + Path.GetFileName(sandbox);
        Process process = Process.Start(info)!;
        processes.Add(process);
        return process;
    }
    try
    {
        Process first = StartLauncher();
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (!File.Exists(report) && DateTime.UtcNow < deadline && !first.HasExited) Thread.Sleep(50);
        Check(File.Exists(report), "ランチャーが代役本体を起動した");
        // 書き込み完了を待つ（ファイルの作成と JSON の書き込みの間を読まない）。
        Thread.Sleep(100);
        using JsonDocument data = JsonDocument.Parse(File.ReadAllText(report));
        Check(data.RootElement.GetProperty("distribution").GetString() == "clickonce", "実プロセスへ配布方式が渡った");
        Check(data.RootElement.GetProperty("launcher").GetString() == Path.Combine(sandbox, "HAKOBI.ClickOnce.exe"), "現在のランチャーのパスが渡った");
        Check(data.RootElement.GetProperty("arguments").EnumerateArray().Select(value => value.GetString()).SequenceEqual(["--hakobi-action=main"]), "実プロセスでも任意スイッチを除外");
        Check(!first.HasExited, "本体が動いている間ランチャーが残る");
        Check(RunningHakobi.PathsForCurrentUser().Contains(Path.Combine(sandbox, "payload", "HAKOBI.exe"), StringComparer.OrdinalIgnoreCase), "同じ利用者の本体プロセスを検出");
        Process second = StartLauncher();
        Thread.Sleep(500);
        Check(!second.HasExited, "二重起動を転送した場合も実行中の本体を待つ");
        File.WriteAllText(exit, "exit");
        string deployedExecutable = Path.Combine(sandbox, "payload", "HAKOBI.exe");
        deadline = DateTime.UtcNow.AddSeconds(5);
        while (RunningHakobi.PathsForCurrentUser().Contains(deployedExecutable, StringComparer.OrdinalIgnoreCase) && DateTime.UtcNow < deadline)
            Thread.Sleep(25);
        Check(!RunningHakobi.PathsForCurrentUser().Contains(deployedExecutable, StringComparer.OrdinalIgnoreCase), "元の本体が終了した");
        Thread.Sleep(350); // app.relaunch() の新プロセス作成までの空白を再現。
        Check(!first.HasExited && !second.HasExited, "再起動までの空白でランチャーを終了しない");
        string replacementReport = Path.Combine(sandbox, "replacement.json");
        string replacementExit = Path.Combine(sandbox, "replacement-exit");
        var replacementStart = new ProcessStartInfo(deployedExecutable) { UseShellExecute = false, CreateNoWindow = true };
        replacementStart.Environment["HAKOBI_LAUNCHER_TEST_REPORT"] = replacementReport;
        replacementStart.Environment["HAKOBI_LAUNCHER_TEST_EXIT"] = replacementExit;
        replacementStart.Environment["HAKOBI_LAUNCHER_TEST_MUTEX"] = @"Local\HAKOBI.Launcher.Replacement." + Path.GetFileName(sandbox);
        Process replacement = Process.Start(replacementStart)!;
        processes.Add(replacement);
        deadline = DateTime.UtcNow.AddSeconds(10);
        while (!File.Exists(replacementReport) && DateTime.UtcNow < deadline && !replacement.HasExited) Thread.Sleep(50);
        Check(File.Exists(replacementReport), "遅れて次の本体が起動した");
        Thread.Sleep(2200);
        Check(!first.HasExited && !second.HasExited, "次の本体が起動したら終了待ちを継続する");
        File.WriteAllText(replacementExit, "exit");
        Check(first.WaitForExit(10000) && second.WaitForExit(10000), "本体終了後に両ランチャーが終了");
        Check(first.ExitCode == 0 && second.ExitCode == 0, "正常終了を伝える");
        Console.WriteLine($"Launcher lifecycle tests passed ({assertions} total assertions).");
    }
    finally
    {
        File.WriteAllText(exit, "exit");
        foreach (Process process in processes)
        {
            if (!process.WaitForExit(5000)) process.Kill(entireProcessTree: true);
            process.Dispose();
        }
        string expectedPrefix = Path.Combine(Path.GetFullPath(Path.GetTempPath()), "hakobi-launcher-test-");
        if (!Path.GetFullPath(sandbox).StartsWith(expectedPrefix, StringComparison.OrdinalIgnoreCase))
            throw new Exception("Unexpected lifecycle-test cleanup path.");
        Directory.Delete(sandbox, recursive: true);
    }
}
