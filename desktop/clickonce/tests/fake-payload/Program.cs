using System.Text.Json;

// 実際のランチャーを検証するためだけの Electron 代役。本番プロジェクトには含めない。
string report = Environment.GetEnvironmentVariable("HAKOBI_LAUNCHER_TEST_REPORT") ?? throw new Exception("No test report configured.");
string exitFile = Environment.GetEnvironmentVariable("HAKOBI_LAUNCHER_TEST_EXIT") ?? throw new Exception("No test exit signal configured.");
string mutexName = Environment.GetEnvironmentVariable("HAKOBI_LAUNCHER_TEST_MUTEX") ?? throw new Exception("No test mutex configured.");
using var singleton = new Mutex(true, mutexName, out bool first);
if (!first) return;
File.WriteAllText(report, JsonSerializer.Serialize(new
{
    arguments = args,
    distribution = Environment.GetEnvironmentVariable("HAKOBI_DISTRIBUTION"),
    launcher = Environment.GetEnvironmentVariable("HAKOBI_CLICKONCE_LAUNCHER"),
    version = Environment.GetEnvironmentVariable("HAKOBI_CLICKONCE_VERSION")
}));
var deadline = DateTime.UtcNow.AddSeconds(30);
while (!File.Exists(exitFile) && DateTime.UtcNow < deadline) Thread.Sleep(50);
singleton.ReleaseMutex();
