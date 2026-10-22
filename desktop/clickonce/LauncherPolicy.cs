using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Hakobi.ClickOnce;

internal static partial class LauncherPolicy
{
    private const string ActionPrefix = "--hakobi-action=";
    private const string TaskPrefix = "--hakobi-task=";
    private static readonly HashSet<string> Actions = new(StringComparer.Ordinal)
    {
        "quick-add", "progress", "timer", "main", "notifications",
        "timer-stop", "timer-start", "connection", "quit"
    };

    // URL や Electron の任意スイッチを渡さず、既存ジャンプリストと同じ操作だけ渡す。
    internal static string[] SafeArguments(IEnumerable<string> arguments)
    {
        string? action = null;
        string? task = null;
        foreach (string argument in arguments)
        {
            if (argument.StartsWith(ActionPrefix, StringComparison.Ordinal))
            {
                string value = argument[ActionPrefix.Length..];
                if (action is null && Actions.Contains(value)) action = value;
            }
            else if (argument.StartsWith(TaskPrefix, StringComparison.Ordinal))
            {
                string value = argument[TaskPrefix.Length..];
                if (TaskIdPattern().IsMatch(value)) task = value;
            }
        }

        if (action is null || (action == "timer-start" && task is null)) return [];
        return action == "timer-start" ? [ActionPrefix + action, TaskPrefix + task] : [ActionPrefix + action];
    }

    internal static bool IsForeignDeployment(string expectedPath, string? actualPath) =>
        actualPath is null || !string.Equals(Path.GetFullPath(expectedPath), Path.GetFullPath(actualPath), StringComparison.OrdinalIgnoreCase);

    internal static ProcessStartInfo CreateStartInfo(string executable, string launcher, string version, IEnumerable<string> arguments)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(executable)!
        };
        foreach (string argument in SafeArguments(arguments)) start.ArgumentList.Add(argument);
        start.Environment["HAKOBI_DISTRIBUTION"] = "clickonce";
        start.Environment["HAKOBI_CLICKONCE_LAUNCHER"] = launcher;
        start.Environment["HAKOBI_CLICKONCE_VERSION"] = version;
        return start;
    }

    [GeneratedRegex(@"\A[A-Za-z0-9-]{1,64}\z", RegexOptions.CultureInvariant)]
    private static partial Regex TaskIdPattern();
}
